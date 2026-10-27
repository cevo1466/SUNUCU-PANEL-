import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { env } from "../env.js";
import { psqlBinary } from "./backup-pg.js";
import { BACKUP_ROOT, localTarget, type StoredBackup } from "./backup-storage.js";
import type { BackupManifest } from "./backup-snapshot.js";

const execFileAsync = promisify(execFile);

/**
 * Yedek dogrulama — "bu arsiv GERCEKTEN geri yuklenebiliyor mu".
 *
 * NEDEN VAR: bir yedegin diskte durmasi hicbir sey kanitlamaz. Arsiv bozuk
 * olabilir, icinde veritabani dokumu olmayabilir, dokum yuklenmeyebilir.
 * Bunlarin hicbiri dosyaya bakarak anlasilmaz — ancak GERI YUKLEMEYI
 * DENEYEREK anlasilir. Panel bir yedegi yalnizca bu test gectiyse "iyi"
 * gosterir; denenmemis yedek "dogrulanmadi" olarak kalir.
 *
 * Bu, projenin baska yerlerdeki kuralinin aynisi: gercegi olc, iddia etme
 * (bkz. mailServerStatus, pureFtpdStatus, service.sh port_healthy).
 *
 * Test CANLI VERIYE DOKUNMAZ: arsiv gecici bir dizine acilir, SQL gecici bir
 * veritabanina yuklenir, ikisi de sonunda silinir.
 */

export interface VerifyDetail {
  archive_readable: boolean;
  manifest_found: boolean;
  /** Manifest'teki her parca arsivde var mi ve sha256'si tutuyor mu. */
  parts_checked: number;
  parts_failed: string[];
  /** Domain dizinindeki dosya sayisi manifest ile tutuyor mu. */
  file_count_expected: number | null;
  file_count_actual: number | null;
  /** SQL dokumleri gecici bir veritabanina GERCEKTEN yuklendi mi. */
  databases_loaded: string[];
  databases_failed: Array<{ name: string; error: string }>;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  detail: VerifyDetail;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("data", (c) => hash.update(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Gecici bir PostgreSQL veritabanina SQL dokumu yukler ve dusurur.
 *
 * NEDEN GERCEKTEN YUKLUYORUZ: dosyanin var olmasi ve boyutunun sifirdan
 * buyuk olmasi, iceriginin gecerli SQL oldugunu GOSTERMEZ. Yarim yazilmis
 * bir dokum de dosya olarak gayet saglikli gorunur.
 */
async function loadPostgresDump(dumpPath: string, tempDbName: string): Promise<void> {
  const psql = psqlBinary();
  if (!fsSync.existsSync(psql)) throw new Error("psql bulunamadı (gömülü PostgreSQL runtime).");
  const url = new URL(env.DATABASE_URL);
  const base = ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username)];
  const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };

  await execFileAsync(psql, [...base, "-d", "postgres", "-c", `CREATE DATABASE "${tempDbName}"`], { env: pgEnv });
  try {
    // ON_ERROR_STOP: SQL icindeki ilk hata testi DUSURSUN. Aksi halde psql
    // hatalari atlayip 0 ile cikar ve bozuk dokum "yuklendi" sayilirdi.
    await execFileAsync(
      psql,
      [...base, "-d", tempDbName, "-v", "ON_ERROR_STOP=1", "-f", dumpPath],
      { env: pgEnv, maxBuffer: 1024 * 1024, timeout: 120_000 },
    );
  } finally {
    await execFileAsync(psql, [...base, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${tempDbName}"`], {
      env: pgEnv,
    }).catch(() => {});
  }
}

async function loadMysqlDump(dumpPath: string, tempDbName: string): Promise<void> {
  const user = process.env.MYSQL_ADMIN_USER ?? "root";
  const password = process.env.MYSQL_ADMIN_PASSWORD ?? "";
  if (!password) throw new Error("MYSQL_ADMIN_PASSWORD tanımlı değil.");
  const host = process.env.MYSQL_HOST ?? "127.0.0.1";
  const port = process.env.MYSQL_PORT ?? "3306";
  const mysqlEnv = { ...process.env, MYSQL_PWD: password };
  const base = ["-h", host, "-P", port, "-u", user];

  await execFileAsync("mysql", [...base, "-e", `CREATE DATABASE \`${tempDbName}\``], { env: mysqlEnv });
  try {
    // DIKKAT — `execFile`'in `input` SECENEGI YOKTUR (o, execFileSync/spawnSync
    // icindir). Once oyle yazilmisti: `mysql` stdin'den veri bekledi, hicbir
    // sey gelmedi ve surec SONSUZA KADAR ASILI KALDI (dogrulama 10 dakikada
    // zaman asimina ugradi). Dokum `SOURCE` ile okutuluyor; yol bizim
    // uretimimiz ve gecici dizinde, kabuk yorumuna girmiyor.
    await execFileAsync(
      "mysql",
      [...base, tempDbName, "-e", `SOURCE ${dumpPath}`],
      { env: mysqlEnv, maxBuffer: 1024 * 1024, timeout: 120_000 },
    );
  } finally {
    await execFileAsync("mysql", [...base, "-e", `DROP DATABASE IF EXISTS \`${tempDbName}\``], {
      env: mysqlEnv,
    }).catch(() => {});
  }
}

/** Tek bir yedegi dogrular. Canli veriye dokunmaz. */
export async function verifyBackup(stored: StoredBackup): Promise<VerifyResult> {
  const detail: VerifyDetail = {
    archive_readable: false,
    manifest_found: false,
    parts_checked: 0,
    parts_failed: [],
    file_count_expected: null,
    file_count_actual: null,
    databases_loaded: [],
    databases_failed: [],
  };

  // Calisma alani yedek agacinin yaninda: /tmp ayri ve kucuk olabilir,
  // 141 MB'lik bir arsivi acmak orayi doldurabilir.
  await fs.mkdir(path.join(BACKUP_ROOT, ".verify"), { recursive: true, mode: 0o750 });
  const work = await fs.mkdtemp(path.join(BACKUP_ROOT, ".verify", "run-"));

  try {
    // 1) Arsiv gercekten aciliyor mu (bozuk gzip / kesik tar burada yakalanir)
    try {
      await execFileAsync("tar", ["-xzf", stored.absolutePath, "-C", work], { maxBuffer: 1024 * 1024 });
      detail.archive_readable = true;
    } catch (err) {
      return { ok: false, error: `Arşiv açılamadı: ${(err as Error).message}`, detail };
    }

    // 2) Manifest
    const manifestPath = path.join(work, "_studio-panel", "manifest.json");
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as BackupManifest;
      detail.manifest_found = true;
    } catch {
      return { ok: false, error: "Arşivde manifest.json yok veya okunamıyor.", detail };
    }

    // 3) Her parcanin sha256'si — arsiv aciliyor ama icerik bozulmus olabilir
    for (const part of manifest.parts) {
      detail.parts_checked += 1;
      const abs = path.join(work, part.path);
      try {
        const actual = await sha256File(abs);
        if (actual !== part.sha256) detail.parts_failed.push(`${part.path} (sha256 uyuşmuyor)`);
      } catch {
        detail.parts_failed.push(`${part.path} (arşivde yok)`);
      }
    }

    // 4) Dosya sayisi
    detail.file_count_expected = manifest.file_count;
    try {
      const { stdout } = await execFileAsync(
        "sh",
        ["-c", `find ${JSON.stringify(path.join(work, manifest.domain_name))} -type f | wc -l`],
        { maxBuffer: 1024 * 64 },
      );
      detail.file_count_actual = Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      detail.file_count_actual = null;
    }

    // 5) SQL dokumlerini GERCEKTEN yukle
    for (const db of manifest.databases) {
      const dumpPath = path.join(work, db.dump);
      // Gecici ad: carpisma olmasin ve neyin ne oldugu belli olsun.
      const tempName = `sp_verify_${crypto.randomBytes(6).toString("hex")}`;
      try {
        if (db.engine === "postgres") await loadPostgresDump(dumpPath, tempName);
        else if (db.engine === "mysql") await loadMysqlDump(dumpPath, tempName);
        else throw new Error(`bilinmeyen motor: ${db.engine}`);
        detail.databases_loaded.push(`${db.engine}:${db.name}`);
      } catch (err) {
        detail.databases_failed.push({ name: `${db.engine}:${db.name}`, error: (err as Error).message });
      }
    }

    const problems: string[] = [];
    if (detail.parts_failed.length) problems.push(`${detail.parts_failed.length} parça bozuk`);
    if (detail.databases_failed.length) problems.push(`${detail.databases_failed.length} veritabanı yüklenemedi`);
    if (
      detail.file_count_expected !== null &&
      detail.file_count_actual !== null &&
      detail.file_count_actual !== detail.file_count_expected
    ) {
      problems.push(
        `dosya sayısı tutmuyor (beklenen ${detail.file_count_expected}, bulunan ${detail.file_count_actual})`,
      );
    }

    return problems.length === 0
      ? { ok: true, detail }
      : { ok: false, error: problems.join("; "), detail };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Bir domainin EN SON yedegini dogrular ve sonucu backup_runs'a yazar.
 * Zamanlanmis dogrulama bunu cagirir.
 */
export async function verifyLatestBackup(
  pg: Pool,
  domainName: string,
): Promise<{ archive: string; result: VerifyResult } | null> {
  const list = await localTarget.list(domainName);
  const latest = list[0];
  if (!latest) return null;

  const result = await verifyBackup(latest);
  await pg.query(
    `UPDATE backup_runs
        SET verified_at = NOW(), verify_status = $1, verify_error = $2, verify_detail = $3
      WHERE domain_name = $4 AND archive_name = $5`,
    [result.ok ? "ok" : "failed", result.error ?? null, JSON.stringify(result.detail), domainName, latest.name],
  );
  return { archive: latest.name, result };
}
