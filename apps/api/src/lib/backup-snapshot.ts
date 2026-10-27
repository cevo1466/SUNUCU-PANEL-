import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { env } from "../env.js";
import {
  assertValidDomainName,
  domainConfPath,
  domainRootPath,
  GENERATED_DIR,
} from "./domain.js";
import { dkimPrivateKeyPath } from "./dkim.js";
import { zoneFilePath } from "./localDns.js";
import { pgDumpBinary } from "./backup-pg.js";
import { BACKUP_ROOT, backupNameForNow, freeBytes, localTarget, type StoredBackup } from "./backup-storage.js";

const execFileAsync = promisify(execFile);

export class BackupError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Manifest sema surumu. Geri yukleme eski surumleri tanimak zorunda. */
export const MANIFEST_VERSION = 1;

export interface BackupManifest {
  version: number;
  kind: "domain";
  domain_name: string;
  created_at: string;
  /** Arsivin icindeki her parca: yol, boyut, sha256. */
  parts: Array<{ path: string; bytes: number; sha256: string; note: string }>;
  /** Domain dizinindeki dosya sayisi — geri yukleme sonrasi kaba dogrulama. */
  file_count: number;
  /** Yedeklenen veritabanlari. */
  databases: Array<{ engine: string; name: string; dump: string; bytes: number }>;
  /** Yedegi ureten surum bilgisi — ileride bicim degisirse teshis icin. */
  produced_by: string;
  /**
   * Beklenen ama ALINAMAYAN parcalar.
   *
   * NEDEN VAR (gercek kusur, 2026-09-01): ilk surum "dosya varsa ekle"
   * mantigiyla calisiyordu. musteri.test'nin DKIM ozel anahtari root'a ait
   * bir dizinde durdugu icin panel onu OKUYAMADI; `existsSync` false dondu ve
   * yedek, icinde DKIM anahtari OLMADAN "basarili" olarak uretildi. DKIM
   * anahtari kaybolursa geri getirilemez (DNS'teki public kayit ona bagli),
   * yani bu sessiz atlama tam olarak kacinmak istedigimiz seydi.
   * Artik eksikler burada kayda gecer ve `complete` false olur.
   */
  warnings: string[];
  /** Beklenen her parca alindiysa true. Panel yalnizca true olani yesil gosterir. */
  complete: boolean;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function countFiles(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", `find ${JSON.stringify(dir)} -type f | wc -l`], {
      maxBuffer: 1024 * 64,
    });
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function dirSizeBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", dir], { maxBuffer: 1024 * 64 });
    return (Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10) || 0) * 1024;
  } catch {
    return 0;
  }
}

/**
 * Domain dizinini stage'e HARD LINK olarak baglar (`cp -al`).
 *
 * NEDEN TEK TEK YAKALAMA GEREKIYOR (gercek kusur, davetiye.ornek.test'da
 * tekrar tekrar goruldu): domain dizininde ROOT'A AIT birkac dosya varsa
 * (ör. bir betigin root olarak yazdigi ekran goruntusu/QA dosyasi), kernel'in
 * `fs.protected_hardlinks` korumasi (bu konteynerde acik) devuser'in o
 * dosyaya hard link atmasini reddeder — sahibi olmadigi bir dosyaya link
 * atmak sembolik link saldirilarina karsi kapatilmis. `cp -al` bunu TEK
 * cagriyla yapiyordu ve busybox cp agac genelinde devam edip sonunda
 * tek bir hata ile cikiyordu; ustteki kod bu hatada TUM yedegi iptal
 * ediyordu — dokunulmamis binlerce dosya olsa bile. Sonuc: bu domain
 * icin GUNLERCE hicbir yedek alinamadi, sessizce.
 *
 * Cozum: `cp -al`'i once dene (hizli, ek disk kullanmaz). Reddedilen
 * dosyalarin yolunu stderr'den ayikla ve SADECE onlari gercek `copyFile`
 * ile kopyala — hardlink sahiplik gerektirir, duz kopya gerektirmez.
 *
 * `warnings`'e YAZILMIYOR BILEREK: icerik eksiksiz kopyalaniyor, yalnizca
 * yontem degisiyor — bu, manifest.complete'i false'a dusurecek gercek bir
 * eksiklik degil. Panel operatoru yine de gorsun diye console.warn kaliyor.
 */
async function linkDomainTree(sourceDir: string, linkedDomain: string): Promise<void> {
  try {
    await execFileAsync("cp", ["-al", sourceDir, linkedDomain], { maxBuffer: 4 * 1024 * 1024 });
    return;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const failedPaths = [...stderr.matchAll(/^cp: can't create '([^']+)':/gm)].map((m) => m[1]);
    if (failedPaths.length === 0) {
      // Taninmayan bir hata — sahiplik disi bir sey olabilir, yutma.
      throw err;
    }
    for (const destPath of failedPaths) {
      const rel = path.relative(linkedDomain, destPath);
      const srcPath = path.join(sourceDir, rel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }
    console.warn(
      `[backup] ${failedPaths.length} dosya root'a ait olduğu için hard link yerine gerçek kopya ile ` +
        `yedeklendi (kernel fs.protected_hardlinks): ${linkedDomain}`,
    );
  }
}

/**
 * Bir domainin TAM anlik goruntusunu alir.
 *
 * "TAM" ne demek: bu arsivle domain sifirdan ayaga kaldirilabilmeli. Eski
 * yedekleme yalnizca /var/www/vhosts/<domain> dizinini aliyordu; o arsivle
 * geri donuldugunde site AYAGA KALKMIYORDU cunku:
 *   - veritabani yok (icerik yonetim sistemi bos bir kabuk olur),
 *   - nginx vhost'u yok (site hic servis edilmez),
 *   - DKIM ozel anahtari yok (giden mailin imzasi kalici olarak bozulur;
 *     anahtar kaybolursa DNS'teki public kayit ise yaramaz hale gelir),
 *   - DNS kayitlari yok (zone yeniden kurulmak zorunda).
 * Bunlarin hepsi domain dizininin DISINDA duruyor, bu yuzden ayrica toplanir.
 */
export async function createDomainSnapshot(
  pg: Pool,
  domainName: string,
): Promise<{ stored: StoredBackup; manifest: BackupManifest }> {
  assertValidDomainName(domainName);
  const sourceDir = domainRootPath(domainName);
  if (!fsSync.existsSync(sourceDir)) {
    throw new BackupError("Domain dizini bulunamadı — önce dizin oluşturulmalı.", 404);
  }

  // Disk korumasi: arsiv sikistirilmis olsa da gecici alan gerekir.
  // Kaynagin ~1.2 kati makul bir tavan; altindaysak BASLAMA. Diski doldurup
  // paneli dusurmek, yedek almamaktan kotudur.
  const sourceBytes = await dirSizeBytes(sourceDir);
  const free = freeBytes();
  if (free !== null && sourceBytes > 0 && free < sourceBytes * 1.2) {
    throw new BackupError(
      `Disk yetersiz: yedek için ~${Math.ceil((sourceBytes * 1.2) / 1024 / 1024)} MB gerekiyor, ` +
        `${Math.floor(free / 1024 / 1024)} MB boş. Eski yedekleri silin veya disk açın.`,
      507,
    );
  }

  // Tum ek parcalar once gecici bir hazirlik dizinine toplanir, sonra tek
  // tar cagrisiyla arsivlenir. Boylece arsiv icindeki duzen sabit ve
  // geri yukleme tarafinda tahmin edilebilir olur.
  // STAGE, /var/www/vhosts ILE AYNI DOSYA SISTEMINDE OLMALI: domain dizini
  // asagida `cp -al` ile HARD LINK olarak baglaniyor ve hard link dosya
  // sistemi sinirini gecemez. /tmp ayri bir fs olabilir, bu yuzden staging
  // yedek agacinin yaninda tutuluyor.
  await fs.mkdir(path.join(BACKUP_ROOT, ".staging"), { recursive: true, mode: 0o750 });
  const stage = await fs.mkdtemp(path.join(BACKUP_ROOT, ".staging", `${domainName}-`));
  const metaDir = path.join(stage, "_studio-panel");
  await fs.mkdir(metaDir, { recursive: true });

  const parts: BackupManifest["parts"] = [];
  const databases: BackupManifest["databases"] = [];
  const warnings: string[] = [];

  /**
   * Beklenen bir dosyayi ekler. OKUNAMIYORSA sessizce gecmez — uyari yazar.
   * `existsSync` izin hatasinda da false doner, bu yuzden gercekten okumayi
   * deneriz: "yok" ile "okuyamiyorum" ayri sorunlardir ve ikincisi duzeltilebilir.
   */
  async function addExpected(
    absPath: string,
    archiveRelPath: string,
    note: string,
    stageDest: string,
    critical: boolean,
  ): Promise<void> {
    try {
      await fs.access(absPath, fsSync.constants.R_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // gercekten yok: bu domain icin beklenmiyor
      warnings.push(
        `${note} OKUNAMADI (${absPath}): ${code}. ` +
          (critical ? "Bu parça olmadan geri yükleme eksik kalır." : ""),
      );
      return;
    }
    await fs.copyFile(absPath, stageDest);
    await addPart(stageDest, archiveRelPath, note);
  }

  async function addPart(absPath: string, archiveRelPath: string, note: string): Promise<void> {
    const stat = await fs.stat(absPath);
    parts.push({ path: archiveRelPath, bytes: stat.size, sha256: await sha256File(absPath), note });
  }

  try {
    // --- nginx vhost ---
    await addExpected(
      domainConfPath(domainName),
      "_studio-panel/nginx.conf",
      "nginx vhost yapılandırması",
      path.join(metaDir, "nginx.conf"),
      true,
    );

    // --- DKIM ozel anahtari ---
    // KAYBOLURSA GERI GETIRILEMEZ: DNS'teki public kayit bu anahtarla
    // eslesiyor. Anahtar giderse tum giden mailin imzasi bozulur ve yeni
    // anahtar uretip DNS'i guncellemek gerekir.
    const dkimDest = path.join(metaDir, "dkim.private");
    await addExpected(
      dkimPrivateKeyPath(domainName),
      "_studio-panel/dkim.private",
      "DKIM özel anahtarı",
      dkimDest,
      true,
    );
    if (fsSync.existsSync(dkimDest)) await fs.chmod(dkimDest, 0o600);

    // --- DNS: hem zone dosyasi hem panelin kayitlari ---
    await addExpected(
      zoneFilePath(domainName),
      "_studio-panel/dns.zone",
      "BIND zone dosyası",
      path.join(metaDir, "dns.zone"),
      false,
    );
    const dnsRows = await pg.query(
      `SELECT dr.record_type, dr.name, dr.content, dr.ttl, dr.priority, dr.weight, dr.port, dr.proxied
         FROM dns_records dr JOIN domains d ON d.id = dr.domain_id
        WHERE d.domain_name = $1 ORDER BY dr.record_type, dr.name`,
      [domainName],
    );
    const dnsJson = path.join(metaDir, "dns-records.json");
    await fs.writeFile(dnsJson, JSON.stringify(dnsRows.rows, null, 2));
    await addPart(dnsJson, "_studio-panel/dns-records.json", `${dnsRows.rowCount} DNS kaydı`);

    // --- Domain kaydi + mail/FTP hesaplari (parola hash'leriyle) ---
    // Hash'ler olmadan geri yukleme, tum kullanicilarin parolalarini
    // sifirlamak demektir. Duz parola YOK, yalnizca dogrulanabilir hash.
    const domainRow = await pg.query(
      `SELECT domain_name, directory_path, ssl_status, ssl_expiry, runtime_type, php_version,
              proxy_port, dns_provider, mail_quota_default_mb, created_at
         FROM domains WHERE domain_name = $1`,
      [domainName],
    );
    const mailRows = await pg.query(
      `SELECT m.local_part, m.password_hash, m.quota_mb, m.enabled, m.created_at
         FROM mail_accounts m JOIN domains d ON d.id = m.domain_id
        WHERE d.domain_name = $1 ORDER BY m.local_part`,
      [domainName],
    );
    const ftpRows = await pg.query(
      `SELECT f.username, f.password_hash, f.home_dir, f.quota_mb, f.enabled, f.created_at
         FROM ftp_accounts f JOIN domains d ON d.id = f.domain_id
        WHERE d.domain_name = $1 ORDER BY f.username`,
      [domainName],
    );
    const stateJson = path.join(metaDir, "panel-records.json");
    await fs.writeFile(
      stateJson,
      JSON.stringify(
        { domain: domainRow.rows[0] ?? null, mail_accounts: mailRows.rows, ftp_accounts: ftpRows.rows },
        null,
        2,
      ),
    );
    await addPart(
      stateJson,
      "_studio-panel/panel-records.json",
      `domain kaydı + ${mailRows.rowCount} mail, ${ftpRows.rowCount} FTP hesabı`,
    );

    // --- Veritabanlari ---
    const dbRows = await pg.query<{ engine: string; db_name: string }>(
      `SELECT pd.engine, pd.db_name FROM panel_databases pd
         JOIN domains d ON d.id = pd.domain_id
        WHERE d.domain_name = $1 ORDER BY pd.db_name`,
      [domainName],
    );
    for (const db of dbRows.rows) {
      const dumpName = `db-${db.engine}-${db.db_name}.sql`;
      const dumpPath = path.join(metaDir, dumpName);
      try {
        await dumpDatabase(db.engine, db.db_name, dumpPath);
        const stat = await fs.stat(dumpPath);
        databases.push({ engine: db.engine, name: db.db_name, dump: `_studio-panel/${dumpName}`, bytes: stat.size });
        await addPart(dumpPath, `_studio-panel/${dumpName}`, `${db.engine} veritabanı dökümü`);
      } catch (err) {
        // TEK BIR VERITABANI DUMP'I BASARISIZ OLURSA TUM YEDEK BASARISIZ OLUR.
        // Sessizce atlamak, "yedegim var" diyip icinde veritabani olmayan bir
        // arsiv birakmak demekti — tam olarak kacinmaya calistigimiz sey.
        throw new BackupError(
          `"${db.db_name}" veritabanı yedeklenemedi: ${(err as Error).message}. Yedek alınmadı.`,
          500,
        );
      }
    }

    const manifest: BackupManifest = {
      version: MANIFEST_VERSION,
      kind: "domain",
      domain_name: domainName,
      created_at: new Date().toISOString(),
      parts,
      file_count: await countFiles(sourceDir),
      databases,
      produced_by: "studio-panel/backup-snapshot",
      warnings,
      complete: warnings.length === 0,
    };
    await fs.writeFile(path.join(metaDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    // --- Arsivleme ---
    // Once .tmp'ye yaz; localTarget.put onu rename ile yerine koyar (atomik).
    // ARSIVLEME — busybox tar'in sinirlarina gore.
    //
    // Ilk denenen `tar -czf X -C /var/www/vhosts <domain> -C stage _meta`
    // (GNU'da calisan cok-`-C` deyimi) BUSYBOX'TA CALISMIYOR: ikinci -C ilkini
    // gecersiz kiliyor ve "No such file or directory" ile dusuyor.
    // `tar -r` (ekleme) da busybox'ta YOK ("unrecognized option: r").
    // `-h` (symlink coz) ise ise yarardi ama SITE ICINDEKI symlink'leri de
    // kopyaya cevirirdi — bir hosting yedeginde kabul edilemez.
    //
    // Cozum: domain dizini stage'e HARD LINK olarak baglanir (`cp -al`:
    // anlik, ek disk kullanmaz, symlink'ler symlink kalir), meta yanina
    // konur ve tek bir -C ile hepsi arsivlenir.
    const linkedDomain = path.join(stage, domainName);
    await linkDomainTree(sourceDir, linkedDomain);

    const tmpArchive = path.join(stage, "archive.tar.gz.tmp");
    await execFileAsync("tar", ["-czf", tmpArchive, "-C", stage, domainName, "_studio-panel"], {
      maxBuffer: 1024 * 1024,
    });

    const finalName = backupNameForNow();
    const stored = await localTarget.put(domainName, tmpArchive, manifest, finalName);
    return { stored, manifest };
  } finally {
    // Hazirlik dizini her durumda temizlenir — icinde DKIM ozel anahtari ve
    // veritabani dokumu var, ortalikta birakilamaz.
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** Tek bir veritabanini dosyaya dokumler. */
async function dumpDatabase(engine: string, dbName: string, destPath: string): Promise<void> {
  if (engine === "postgres") {
    const pgDump = pgDumpBinary();
    if (!fsSync.existsSync(pgDump)) throw new Error("pg_dump bulunamadı (gömülü PostgreSQL runtime).");
    const url = new URL(env.DATABASE_URL);
    await execFileAsync(
      pgDump,
      ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username), "-f", destPath, dbName],
      { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, maxBuffer: 1024 * 1024 },
    );
    return;
  }
  if (engine === "mysql") {
    const user = process.env.MYSQL_ADMIN_USER ?? "root";
    const password = process.env.MYSQL_ADMIN_PASSWORD ?? "";
    if (!password) throw new Error("MYSQL_ADMIN_PASSWORD tanımlı değil.");
    const host = process.env.MYSQL_HOST ?? "127.0.0.1";
    const port = process.env.MYSQL_PORT ?? "3306";
    // Parola KOMUT SATIRINDA GECMEZ (ps ciktisinda gorunurdu); MYSQL_PWD ile.
    await execFileAsync(
      "mysqldump",
      ["-h", host, "-P", port, "-u", user, "--single-transaction", "--result-file", destPath, dbName],
      { env: { ...process.env, MYSQL_PWD: password }, maxBuffer: 1024 * 1024 },
    );
    return;
  }
  throw new Error(`Bilinmeyen veritabanı motoru: ${engine}`);
}

export { localTarget };
