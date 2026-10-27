import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { DatabaseError, mysqlConnection, type DbEngine, type PanelDatabaseRow } from "./databases.js";
import { psqlBinary } from "./backup-pg.js";

const execFileAsync = promisify(execFile);

/**
 * Disaridan alinmis bir SQL dokumunu MEVCUT bir veritabanina yukler.
 *
 * KAPSAM KARARI — veritabani OLUSTURULMAZ, var olan doldurulur. Dokumun
 * icindeki `CREATE DATABASE` / `USE` satirlari panelin hesap ve yetki
 * kayitlarini atlatarak sunucuda panelin bilmedigi veritabanlari
 * yaratabilirdi; yukleme her zaman panelin actigi ve sahipligini bildigi bir
 * veritabanina yapilir.
 */

/** Tek bir yuklemede kabul edilen en buyuk dosya. */
export const MAX_IMPORT_BYTES = Number(process.env.MAX_DB_IMPORT_BYTES ?? 512 * 1024 * 1024);

/** Yukleme suresi tavani. Buyuk dokumlar dakikalar surebilir. */
const IMPORT_TIMEOUT_MS = Number(process.env.DB_IMPORT_TIMEOUT_MS ?? 900_000);

export interface ImportResult {
  engine: DbEngine;
  database: string;
  /** Diskteki (gerekiyorsa acilmis) dokum boyutu. */
  bytes: number;
  /** Dosya gzip'li geldiyse true. */
  gzipped: boolean;
  /** Istemcinin yazdigi uyarilar — bos degilse kullaniciya gosterilir. */
  warnings: string[];
}

/**
 * Dosya adindan gzip olup olmadigini ANLAMAYIZ — icerige bakariz.
 *
 * Uzantiya guvenmek iki yonlu yaniltir: `.sql` adiyla gelen gzip dosyasi
 * psql'e ham verilir ve "syntax error" ile duser; `.gz` adiyla gelen duz SQL
 * ise gunzip'te patlar. Ikisi de kullaniciya sebebi anlasilmaz bir hata
 * gosterirdi. Gzip'in sihirli sayisi iki bayt: 1f 8b.
 */
async function isGzip(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buffer, 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

/** Gzip'li dokumu ayni gecici dizine acar ve yeni yolu doner. */
async function gunzipTo(sourcePath: string, targetPath: string): Promise<void> {
  await pipeline(
    fsSync.createReadStream(sourcePath),
    createGunzip(),
    fsSync.createWriteStream(targetPath),
  );
}

/**
 * Dokumun ILK satirlarinda tehlikeli komut var mi.
 *
 * Tam bir SQL ayristiricisi degil ve oyle olmadigini soyluyor: amaci
 * kullaniciyi YANLISLIKLA baska bir veritabanini ezmekten korumak, kotu
 * niyetli bir dokumu durdurmak DEGIL (dosyayi zaten yetkili kullanici
 * yukluyor). `DROP DATABASE` gibi bir satir bulunursa islem reddedilir ve
 * sebebi soylenir.
 */
async function scanForDangerousStatements(filePath: string): Promise<string[]> {
  const found: string[] = [];
  const handle = await fs.open(filePath, "r");
  try {
    // Ilk 256 KB yeterli: bu ifadeler dokumun basinda bulunur.
    const buffer = Buffer.alloc(Math.min(256 * 1024, (await handle.stat()).size));
    await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.toString("utf8");
    if (/^\s*DROP\s+DATABASE\b/im.test(head)) found.push("DROP DATABASE");
    if (/^\s*CREATE\s+DATABASE\b/im.test(head)) found.push("CREATE DATABASE");
    if (/^\s*(CREATE|ALTER|DROP)\s+(USER|ROLE)\b/im.test(head)) found.push("CREATE/ALTER/DROP USER");
    if (/^\s*GRANT\b/im.test(head)) found.push("GRANT");
  } finally {
    await handle.close();
  }
  return found;
}

async function importPostgres(dumpPath: string, dbName: string): Promise<string[]> {
  const psql = psqlBinary();
  if (!fsSync.existsSync(psql)) {
    throw new DatabaseError(
      "PostgreSQL istemcisi (psql) bulunamadı; içe aktarma yapılamıyor.",
      500,
    );
  }
  const url = new URL(process.env.DATABASE_URL ?? "postgres://studio:studio@127.0.0.1:5433/studio_panel");
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  const { stderr } = await execFileAsync(
    psql,
    [
      "-h", url.hostname,
      "-p", url.port || "5432",
      "-U", decodeURIComponent(url.username),
      "-d", dbName,
      // ON_ERROR_STOP: hatada DURUR. Olmadan psql hatali satirlari atlayip
      // 0 ile cikar; panel "yuklendi" der, veritabani yarim kalirdi.
      "-v", "ON_ERROR_STOP=1",
      "-f", dumpPath,
    ],
    { env, maxBuffer: 4 * 1024 * 1024, timeout: IMPORT_TIMEOUT_MS },
  );
  return clientNotices(stderr);
}

async function importMysql(dumpPath: string, dbName: string): Promise<string[]> {
  const { host, port } = mysqlConnection();
  const user = process.env.MYSQL_ADMIN_USER ?? "root";
  const password = process.env.MYSQL_ADMIN_PASSWORD ?? "";
  if (!password) {
    throw new DatabaseError("MYSQL_ADMIN_PASSWORD tanımlı değil; içe aktarma yapılamıyor.", 500);
  }
  // `SOURCE <yol>` kullaniliyor, stdin YONLENDIRMESI DEGIL: execFile'in
  // `input` secenegi yoktur ve dosyayi stdin'e vermeye calismak mysql'i
  // girdi beklerken asili birakir (bu daha once yasandi, 10 dakika bekledi).
  //
  // --abort-source-on-error ZORUNLU. Onsuz `SOURCE` hatali bir ifadede
  // durmaz, hatayi stderr'e yazip DEVAM eder ve mysql 0 ILE CIKAR. Yani
  // tamamen gecersiz bir dosya "basariyla yuklendi" gorunurdu — kendi
  // testimde tam olarak bu oldu (2026-09-01). Yarim yuklenmis bir
  // veritabanini "tamam" diye raporlamak, hic yuklememekten daha kotudur.
  const { stderr } = await execFileAsync(
    "mysql",
    [
      "-h", host,
      "-P", String(port),
      "-u", user,
      "--abort-source-on-error",
      dbName,
      "-e", `SOURCE ${dumpPath}`,
    ],
    {
      env: { ...process.env, MYSQL_PWD: password },
      maxBuffer: 4 * 1024 * 1024,
      timeout: IMPORT_TIMEOUT_MS,
    },
  );
  // Ikinci kapi: bayrak bir istemci surumunde yok sayilirsa bile hata
  // satirlarini yakala. Cikis kodu 0 diye "basarili" demiyoruz.
  assertNoSqlError(stderr);
  return clientNotices(stderr);
}

/**
 * Istemcinin kendi TLS/parola uyarilari kullaniciya GOSTERILMEZ.
 *
 * MariaDB istemcisi her calismada
 *   "WARNING: option --ssl-verify-server-cert is disabled..."
 * yaziyor. Bunu "yukleme uyarisi" diye gostermek her basarili islemi
 * supheli gosterirdi; kullanici gercek bir uyariyi bu gurultunun icinde
 * kacirirdi.
 */
function clientNotices(stderr: string): string[] {
  return stderr
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/ssl-verify-server-cert|Using a password on the command line/i.test(line))
    .slice(-10);
}

/** stderr'de SQL hatasi varsa cikis kodu 0 olsa bile basarisiz sayar. */
function assertNoSqlError(stderr: string): void {
  const errorLine = stderr
    .split("\n")
    .find((line) => /^\s*ERROR\s+\d+/i.test(line) || /^\s*ERROR\b/i.test(line));
  if (errorLine) {
    throw new DatabaseError(`İçe aktarma tamamlanamadı: ${errorLine.trim()}`, 409);
  }
}

/**
 * Yuklemeyi yapar. `sourcePath` gecici bir dosyadir; cagiran silmekle
 * yukumludur (bu fonksiyon yalnizca KENDI actigi gecici dizini temizler).
 */
export async function importSqlDump(
  row: PanelDatabaseRow,
  sourcePath: string,
): Promise<ImportResult> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "studio-db-import-"));
  try {
    const gzipped = await isGzip(sourcePath);
    let dumpPath = sourcePath;
    if (gzipped) {
      dumpPath = path.join(work, "dump.sql");
      try {
        await gunzipTo(sourcePath, dumpPath);
      } catch (err) {
        throw new DatabaseError(
          `Dosya gzip olarak açılamadı: ${(err as Error).message}`,
          400,
        );
      }
    }

    const stat = await fs.stat(dumpPath);
    if (stat.size === 0) {
      throw new DatabaseError("Dosya boş.", 400);
    }

    const dangerous = await scanForDangerousStatements(dumpPath);
    if (dangerous.some((item) => item === "DROP DATABASE" || item === "CREATE DATABASE")) {
      throw new DatabaseError(
        `Dosya ${dangerous.join(", ")} ifadesi içeriyor. İçe aktarma yalnızca mevcut bir veritabanının içine yapılır; ` +
          "dökümü alırken veritabanı oluşturma satırlarını hariç tutun " +
          "(mysqldump için --no-create-db, pg_dump için varsayılan davranış).",
        400,
      );
    }

    const warnings: string[] = [];
    if (dangerous.length > 0) {
      warnings.push(
        `Dosyada ${dangerous.join(", ")} ifadeleri var; bunlar panelin yetki kayıtlarını değiştirmez ve sunucuda hataya yol açabilir.`,
      );
    }

    let clientOutput: string[];
    try {
      clientOutput =
        row.engine === "postgres"
          ? await importPostgres(dumpPath, row.db_name)
          : await importMysql(dumpPath, row.db_name);
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      const holder = err as { stderr?: string; killed?: boolean; message?: string };
      if (holder.killed) {
        throw new DatabaseError(
          `İçe aktarma ${Math.round(IMPORT_TIMEOUT_MS / 1000)} saniyede tamamlanmadı ve durduruldu.`,
          409,
        );
      }
      // Istemcinin KENDI hata metni gosterilir: "satir 4213: syntax error"
      // gibi bir mesaj, genel bir "içe aktarma başarısız"dan cok daha
      // kullanislidir.
      const detail = (holder.stderr ?? holder.message ?? "").trim().split("\n").slice(-5).join(" ");
      throw new DatabaseError(
        `İçe aktarma tamamlanamadı: ${detail || "istemci hata verdi"}`,
        409,
      );
    }

    warnings.push(...clientOutput.filter((line) => /warning/i.test(line)));

    return {
      engine: row.engine,
      database: row.db_name,
      bytes: stat.size,
      gzipped,
      warnings,
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
