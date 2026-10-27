import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { PGDATA_DIR, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from "./config.js";
import { ensureRuntimeInstalled, PG_BIN_DIR, pgLdLibraryPath } from "./runtime.js";

const execFileAsync = promisify(execFile);

function pgEnv() {
  return { ...process.env, LD_LIBRARY_PATH: pgLdLibraryPath() };
}

async function initdbIfNeeded() {
  if (fs.existsSync(PGDATA_DIR)) return;

  const pwFile = path.join(await fsp.mkdtemp(path.join("/tmp", "studio-pg-pw-")), "pw");
  await fsp.writeFile(pwFile, DB_PASSWORD);
  try {
    console.log(`» initdb: ${PGDATA_DIR}`);
    await execFileAsync(
      path.join(PG_BIN_DIR, "initdb"),
      [
        "-D",
        PGDATA_DIR,
        "-U",
        DB_USER,
        `--pwfile=${pwFile}`,
        // Yerel unix soketi kapali (TCP-only calisiyoruz), TCP tarafi ise
        // gercek parola dogrulamasi ister. Bkz. hardenHostAuth().
        "--auth-local=trust",
        "--auth-host=scram-sha-256",
        "-E",
        "UTF8",
      ],
      { env: pgEnv() },
    );
  } finally {
    await fsp.rm(path.dirname(pwFile), { recursive: true, force: true });
  }
}

/**
 * TCP baglantilarini `trust` yerine `scram-sha-256`'ya cevirir.
 *
 * NEDEN: initdb bu kumeyi `--auth=trust` ile kurmustu, yani 127.0.0.1'den
 * gelen HERKES parolasiz baglanabiliyordu. Panel kendi baglantisi icin parola
 * gonderdiginden fark edilmiyordu; ama veritabani modulu kullaniciya "su
 * parolayla baglan" diyen gercek roller uretiyor. `trust` acikken o parolalarin
 * hicbir baglayiciligi olmazdi: rastgele bir parolayla, hatta parolasiz,
 * baska bir kullanicinin veritabanina baglanilabilirdi.
 *
 * Idempotent: dosya zaten sertlestirilmisse dokunulmaz. Mevcut kumelerde de
 * calisir, yeniden kurulum gerekmez.
 *
 * @returns Dosya degistiyse true (cagiran reload etmeli).
 */
async function hardenHostAuth(): Promise<boolean> {
  const hbaPath = path.join(PGDATA_DIR, "pg_hba.conf");
  if (!fs.existsSync(hbaPath)) return false;

  const original = await fsp.readFile(hbaPath, "utf8");
  const hardened = original
    .split("\n")
    .map((line) => {
      // Yalnizca yorum olmayan `host`/`hostssl`/`hostnossl` satirlarinin
      // yontem sutunu degisir; `local` satirlari oldugu gibi kalir.
      if (/^\s*#/.test(line) || !/^\s*host(ssl|nossl)?\s/.test(line)) return line;
      return line.replace(/\btrust\s*$/, "scram-sha-256");
    })
    .join("\n");

  if (hardened === original) return false;
  await fsp.writeFile(hbaPath, hardened, { mode: 0o600 });
  console.log("» pg_hba.conf sertlestirildi: TCP baglantilari artik scram-sha-256 istiyor");
  return true;
}

function logPath() {
  return path.join(PGDATA_DIR, "server.log");
}

/**
 * Aynı veri dizininde zaten çalışan bir sunucu var mı?
 *
 * `pg_ctl status` çıkış kodu 0 ise çalışıyor, 3 ise durmuş demektir. Bu kontrol
 * olmadan self-test'ler panel canlıyken hiç koşamıyordu: pg_ctl start
 * "postmaster.pid already exists" ile düşüyordu ve ./verify.sh yalnızca panel
 * kapatıldığında geçebiliyordu.
 */
async function isAlreadyRunning(): Promise<boolean> {
  if (!fs.existsSync(path.join(PGDATA_DIR, "postmaster.pid"))) return false;
  try {
    await execFileAsync(path.join(PG_BIN_DIR, "pg_ctl"), ["-D", PGDATA_DIR, "status"], {
      env: pgEnv(),
    });
    return true;
  } catch {
    // Çıkış kodu 0 değil — süreç yok, geride kalmış bir kilit dosyası var.
    return false;
  }
}

/**
 * @returns startedByUs — sunucuyu bu çağrı mı ayağa kaldırdı. Zaten çalışan bir
 * sunucu kullanıldıysa false döner ve çağıran onu durdurmamalıdır: aksi halde
 * bir self-test, canlı panelin veritabanını kapatır.
 */
export async function startPostgres(): Promise<{ startedByUs: boolean }> {
  await ensureRuntimeInstalled();
  await initdbIfNeeded();

  const authChanged = await hardenHostAuth();

  if (await isAlreadyRunning()) {
    console.log(`» PostgreSQL zaten çalışıyor (127.0.0.1:${DB_PORT}) — mevcut sunucu kullanılıyor`);
    // Çalışan sunucu pg_hba.conf'u yalnızca reload'da yeniden okur.
    if (authChanged) {
      await execFileAsync(path.join(PG_BIN_DIR, "pg_ctl"), ["-D", PGDATA_DIR, "reload"], {
        env: pgEnv(),
      });
    }
    await ensureDatabaseExists();
    return { startedByUs: false };
  }

  console.log(`» PostgreSQL başlatılıyor (127.0.0.1:${DB_PORT})...`);
  await execFileAsync(
    path.join(PG_BIN_DIR, "pg_ctl"),
    [
      "-D",
      PGDATA_DIR,
      "-o",
      `-p ${DB_PORT} -c unix_socket_directories=''`,
      "-l",
      logPath(),
      "-w",
      "start",
    ],
    { env: pgEnv() },
  );

  await ensureDatabaseExists();
  return { startedByUs: true };
}

export async function stopPostgres(): Promise<void> {
  if (!fs.existsSync(PGDATA_DIR)) return;
  try {
    await execFileAsync(
      path.join(PG_BIN_DIR, "pg_ctl"),
      ["-D", PGDATA_DIR, "-m", "fast", "stop"],
      { env: pgEnv() },
    );
    console.log("✓ PostgreSQL durduruldu");
  } catch (err) {
    // Zaten kapalıysa pg_ctl hata verir — bunu sessizce yut, gerçek hataları yutma.
    const msg = String(err);
    if (!msg.includes("is not running") && !msg.includes("PID file")) {
      throw err;
    }
  }
}

async function ensureDatabaseExists(): Promise<void> {
  const client = new Client({
    host: "127.0.0.1",
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: "postgres",
  });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
    if (rows.length === 0) {
      // CREATE DATABASE parametrize edilemez; DB_NAME sabit koddan geliyor (kullanıcı girdisi değil).
      await client.query(`CREATE DATABASE ${DB_NAME}`);
      console.log(`✓ '${DB_NAME}' veritabanı oluşturuldu`);
    }
  } finally {
    await client.end();
  }
}
