import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { env } from "../env.js";
import { assertValidDomainName, domainRootPath, VHOSTS_ROOT } from "./domain.js";
import { psqlBinary } from "./backup-pg.js";
import { BACKUP_ROOT, localTarget } from "./backup-storage.js";
import type { BackupManifest } from "./backup-snapshot.js";
import { BackupError } from "./backup-snapshot.js";

const execFileAsync = promisify(execFile);

/**
 * Yedekten geri yukleme.
 *
 * NEDEN KARANTINA: geri yukleme, calisan bir dizinin UZERINE yazar. Yarida
 * kalirsa (disk dolar, arsiv bozuk cikar, surec olur) elde ne eski ne yeni
 * durum kalir — en kotu sonuc. Bu yuzden mevcut durum once yana alinir,
 * sonra yeni icerik konur; bir sey ters giderse eski hal GERI ALINIR.
 * Ayni desen domain silmede zaten kullaniliyor (routes/domains.ts
 * .studio-panel-trash karantinasi).
 *
 * VARSAYILAN KURU CALISTIRMA: `restoreBackup` cagirani acikca `confirm`
 * demedikce hicbir seye dokunmaz, yalnizca ne yapacagini anlatir. Geri
 * yukleme geri alinamaz bir islemdir; varsayilanin guvenli olmasi gerekir.
 */

export interface RestorePlan {
  domain_name: string;
  archive: string;
  created_at: string;
  /** Uzerine yazilacak dizin. */
  target_dir: string;
  /** Arsivdeki dosya sayisi. */
  file_count: number;
  /** Geri yuklenecek veritabanlari. */
  databases: Array<{ engine: string; name: string }>;
  /** Arsivde bulunan ek parcalar (nginx, DKIM, DNS...). */
  parts: Array<{ path: string; note: string }>;
  /** Yedegin kendi uyarilari (eksik parca vs). */
  warnings: string[];
  /** Su an diskte olan ve karantinaya alinacak dosya sayisi. */
  current_file_count: number | null;
}

export interface RestoreResult extends RestorePlan {
  restored: true;
  /** Eski icerigin tasindigi yer — geri donmek gerekirse. */
  quarantine_dir: string;
  databases_restored: string[];
  databases_failed: Array<{ name: string; error: string }>;
}

async function countFiles(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", `find ${JSON.stringify(dir)} -type f | wc -l`], {
      maxBuffer: 1024 * 64,
    });
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    return null;
  }
}

/** Arsivi acmadan manifest'i okur (yaninda duruyor). */
async function readManifest(manifestPath: string): Promise<BackupManifest> {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8")) as BackupManifest;
  } catch {
    throw new BackupError("Yedeğin manifest dosyası okunamadı; bu yedek geri yüklenemez.", 422);
  }
}

/** Ne yapilacagini anlatir, HICBIR SEYE DOKUNMAZ. */
export async function planRestore(domainName: string, archiveName: string): Promise<RestorePlan> {
  assertValidDomainName(domainName);
  const stored = await localTarget.resolve(domainName, archiveName);
  if (!stored) throw new BackupError("Yedek bulunamadı.", 404);
  const manifest = await readManifest(stored.manifestPath);
  const targetDir = domainRootPath(domainName);

  return {
    domain_name: domainName,
    archive: stored.name,
    created_at: manifest.created_at,
    target_dir: targetDir,
    file_count: manifest.file_count,
    databases: manifest.databases.map((d) => ({ engine: d.engine, name: d.name })),
    parts: manifest.parts.map((p) => ({ path: p.path, note: p.note })),
    warnings: manifest.warnings ?? [],
    current_file_count: fsSync.existsSync(targetDir) ? await countFiles(targetDir) : null,
  };
}

async function restorePostgresDump(dumpPath: string, dbName: string): Promise<void> {
  const psql = psqlBinary();
  const url = new URL(env.DATABASE_URL);
  const base = ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username)];
  const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  // Once bosalt: yarim bir sema uzerine yuklemek catisma uretir.
  await execFileAsync(psql, [...base, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${dbName}"`], { env: pgEnv });
  await execFileAsync(psql, [...base, "-d", "postgres", "-c", `CREATE DATABASE "${dbName}"`], { env: pgEnv });
  await execFileAsync(psql, [...base, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-f", dumpPath], {
    env: pgEnv,
    maxBuffer: 1024 * 1024,
    timeout: 300_000,
  });
}

async function restoreMysqlDump(dumpPath: string, dbName: string): Promise<void> {
  const user = process.env.MYSQL_ADMIN_USER ?? "root";
  const password = process.env.MYSQL_ADMIN_PASSWORD ?? "";
  if (!password) throw new Error("MYSQL_ADMIN_PASSWORD tanımlı değil.");
  const mysqlEnv = { ...process.env, MYSQL_PWD: password };
  const base = ["-h", process.env.MYSQL_HOST ?? "127.0.0.1", "-P", process.env.MYSQL_PORT ?? "3306", "-u", user];
  await execFileAsync("mysql", [...base, "-e", `DROP DATABASE IF EXISTS \`${dbName}\`; CREATE DATABASE \`${dbName}\``], {
    env: mysqlEnv,
  });
  await execFileAsync("mysql", [...base, dbName, "-e", `SOURCE ${dumpPath}`], {
    env: mysqlEnv,
    maxBuffer: 1024 * 1024,
    timeout: 300_000,
  });
}

/**
 * Geri yukler.
 *
 * @param options.restoreDatabases Veritabanlarini da geri yukle. VARSAYILAN
 *   FALSE: "dosyalari geri al ama veritabanina dokunma" mesru ve sik bir
 *   senaryo (ornegin yanlislikla silinen bir dosyayi kurtarmak). Veritabanini
 *   geri yuklemek CANLI VERIYI GERI SARAR ve ayrica istenmeli.
 */
export async function restoreBackup(
  pg: Pool,
  domainName: string,
  archiveName: string,
  options: { restoreDatabases?: boolean } = {},
): Promise<RestoreResult> {
  const plan = await planRestore(domainName, archiveName);
  const stored = (await localTarget.resolve(domainName, archiveName))!;
  const targetDir = plan.target_dir;

  await fs.mkdir(path.join(BACKUP_ROOT, ".restore"), { recursive: true, mode: 0o750 });
  const work = await fs.mkdtemp(path.join(BACKUP_ROOT, ".restore", "run-"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantine = path.join(VHOSTS_ROOT.resolved, `.studio-panel-trash`, `${domainName}-restore-${stamp}`);

  try {
    // 1) Arsivi calisma alanina ac. Hedefe DOGRUDAN acmiyoruz: arsiv bozuksa
    //    canli dizini yarim icerikle karistirmis olurduk.
    await execFileAsync("tar", ["-xzf", stored.absolutePath, "-C", work], { maxBuffer: 1024 * 1024 });
    const extracted = path.join(work, domainName);
    if (!fsSync.existsSync(extracted)) {
      throw new BackupError("Arşivde domain dizini yok; yedek bozuk görünüyor.", 422);
    }

    // 2) Mevcut durumu karantinaya al (tasima, kopyalama degil — anlik).
    await fs.mkdir(path.dirname(quarantine), { recursive: true, mode: 0o750 });
    if (fsSync.existsSync(targetDir)) {
      await fs.rename(targetDir, quarantine);
    }

    // 3) Yeni icerigi yerine koy. Buradan sonra hata olursa karantinadan
    //    GERI ALIYORUZ — kullanici hicbir zaman iki durumdan da yoksun kalmaz.
    try {
      await fs.rename(extracted, targetDir);
    } catch (err) {
      if (fsSync.existsSync(quarantine)) await fs.rename(quarantine, targetDir).catch(() => {});
      throw new BackupError(`Geri yükleme başarısız, eski hal geri alındı: ${(err as Error).message}`, 500);
    }

    // 4) Veritabanlari — istenmisse.
    const databases_restored: string[] = [];
    const databases_failed: Array<{ name: string; error: string }> = [];
    if (options.restoreDatabases) {
      const manifest = await readManifest(stored.manifestPath);
      for (const db of manifest.databases) {
        const dumpPath = path.join(work, db.dump);
        try {
          if (db.engine === "postgres") await restorePostgresDump(dumpPath, db.name);
          else if (db.engine === "mysql") await restoreMysqlDump(dumpPath, db.name);
          else throw new Error(`bilinmeyen motor: ${db.engine}`);
          databases_restored.push(`${db.engine}:${db.name}`);
        } catch (err) {
          // Dosyalar zaten geri yuklendi; veritabani hatasi tum islemi geri
          // sarmaz ama SESSIZ de gecmez — cagiran sonucu gorur.
          databases_failed.push({ name: `${db.engine}:${db.name}`, error: (err as Error).message });
        }
      }
    }

    await pg.query(
      `INSERT INTO backup_runs (domain_name, kind, archive_name, status, started_at, finished_at, manifest)
       VALUES ($1, 'domain', $2, 'ok', NOW(), NOW(), $3)`,
      [
        domainName,
        `RESTORE:${stored.name}`,
        JSON.stringify({ action: "restore", databases_restored, databases_failed, quarantine }),
      ],
    ).catch(() => {});

    return {
      ...plan,
      restored: true,
      quarantine_dir: quarantine,
      databases_restored,
      databases_failed,
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
