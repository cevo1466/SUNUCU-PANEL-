import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";
import { GENERATED_DIR, domainRootPath } from "./domain.js";
import { sha512Crypt } from "./crypt.js";
import { PROJECT_ROOT } from "../env.js";

const execFileAsync = promisify(execFile);
const FTP_CTL_SCRIPT = path.join(PROJECT_ROOT, "ops", "scripts", "ftp-ctl.sh");

/**
 * FTP hesapları — pure-ftpd SANAL kullanıcıları.
 *
 * Neden sanal kullanıcı: Linux hesabı açmak ve 21. porta bağlanmak root
 * gerektiriyor, bu konteynerde `sudo` parola istiyor. Sanal kullanıcılarda
 * panel hesabı tek başına yönetebiliyor; root yalnızca pure-ftpd'yi kurup
 * üretilen parola veritabanını yüklerken bir kez gerekiyor.
 * Aynı desen SSL'de (ssl-issue.sh) ve Nginx'te (deploy-vhost.sh) zaten var.
 */

export class FtpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const PUREFTPD_PASSWD_PATH = path.join(GENERATED_DIR, "pureftpd.passwd");

/** pure-ftpd kullanıcı adı kuralları; kabuk/ayrıştırıcı sürprizi olmasın diye dar tutuldu. */
const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/;

export function assertValidUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new FtpError(
      "Kullanıcı adı küçük harfle başlamalı; 3-32 karakter, yalnızca küçük harf, rakam, _ ve - içerebilir.",
      400,
    );
  }
}

/** Domain adından okunabilir bir varsayılan kullanıcı adı türetir. */
export function suggestUsername(domainName: string): string {
  const base = domainName
    .toLowerCase()
    .replace(/\..*$/, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24);
  return base.length >= 3 ? base : `ftp${base}`.slice(0, 24).padEnd(3, "0");
}

export { generatePassword } from "./crypt.js";

/**
 * Parolayi SHA-512 crypt (`$6$...`) bicimine cevirir — pure-ftpd'nin sanal
 * kullanici veritabaninin bekledigi bicim.
 *
 * Govde lib/crypt.ts'e tasindi (e-posta modulu ayni hash'i kullaniyor);
 * burada yalnizca hata tipi FtpError'a cevriliyor, boylece routes/ftp.ts'in
 * `error instanceof FtpError` dali ve mevcut 500 govdesi aynen calisiyor.
 */
export async function hashPassword(password: string): Promise<string> {
  try {
    return await sha512Crypt(password);
  } catch (err) {
    throw new FtpError(`Parola hash'i üretilemedi: ${(err as Error).message}`, 500);
  }
}

export interface FtpAccountRow {
  id: number;
  domain_id: number;
  username: string;
  password_hash: string;
  home_dir: string;
  quota_mb: number | null;
  enabled: boolean;
  created_at: Date;
  domain_name?: string;
}

/**
 * pure-ftpd sanal kullanıcı veritabanını (düz metin kaynağı) yeniden üretir.
 *
 * Biçim, `pure-pw mkdb`'nin okuduğu iki nokta ile ayrılmış satırlar:
 *   login:hash:uid:gid:gecos:home:ul_bw:dl_bw:ul_ratio:dl_ratio:maxcon:
 *   files_quota:size_quota:auth_local_ip:refused_local_ip:auth_client_ip:
 *   refused_client_ip:time_restrictions
 *
 * uid/gid, /var/www/vhosts dizininin MEVCUT sahibine eşlenir. Yeni bir sistem
 * kullanıcısı uydurulmuyor: aksi halde FTP ile yüklenen dosyalar panelin
 * kendi dosya yöneticisiyle yönetilemez ve Nginx okuyamaz hale gelirdi.
 */
export async function writePureFtpdPasswd(
  pool: Pool | PoolClient,
  vhostsRoot: string,
): Promise<string> {
  const { uid, gid } = await fs.stat(vhostsRoot);

  const { rows } = await pool.query<FtpAccountRow>(
    `SELECT f.username, f.password_hash, f.home_dir, f.quota_mb, f.enabled, d.domain_name
       FROM ftp_accounts f
       JOIN domains d ON d.id = f.domain_id
      WHERE f.enabled = TRUE
      ORDER BY f.username`,
  );

  const lines = rows.map((row) => {
    // size_quota megabayt değil BAYT bekleniyor.
    const sizeQuota = row.quota_mb ? String(row.quota_mb * 1024 * 1024) : "";
    return [
      row.username,
      row.password_hash,
      String(uid),
      String(gid),
      `Studio Panel FTP (${row.domain_name})`,
      // Sondaki "/." pure-ftpd'ye kullanıcıyı bu dizine chroot etmesini söyler.
      `${row.home_dir}/./`,
      "", // upload bandwidth
      "", // download bandwidth
      "", // upload ratio
      "", // download ratio
      "", // max connections
      "", // files quota
      sizeQuota,
      "", // authorized local IPs
      "", // refused local IPs
      "", // authorized client IPs
      "", // refused client IPs
      "", // time restrictions
    ].join(":");
  });

  const content = lines.length ? lines.join("\n") + "\n" : "";
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  // 600: dosya parola hash'leri taşıyor. Düz metin parola HİÇBİR zaman yazılmaz.
  const temporaryPath = `${PUREFTPD_PASSWD_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, { mode: 0o600 });
  await fs.rename(temporaryPath, PUREFTPD_PASSWD_PATH);
  await fs.chmod(PUREFTPD_PASSWD_PATH, 0o600);

  return PUREFTPD_PASSWD_PATH;
}

/** Hesabın chroot edileceği dizin — domainin kendi kökü. */
export function ftpHomeDir(domainName: string): string {
  return domainRootPath(domainName);
}

/**
 * PureDB'yi (ops/generated/pureftpd.passwd'den) yeniden derler ve pure-ftpd'yi
 * restart eder — deploy-vhost.sh/deploy-zone.sh ile aynı desen. PureDB canlı
 * sorgu desteklemediği için hesap değişikliği ancak bu çağrıyla devreye girer.
 */
export async function applyPureFtpdReload(): Promise<{ applied: boolean; error?: string }> {
  try {
    await execFileAsync("sudo", [FTP_CTL_SCRIPT, "reload"], { timeout: 15_000 });
    return { applied: true };
  } catch (err) {
    const message =
      err && typeof err === "object" && "stderr" in err && (err as { stderr?: string }).stderr
        ? (err as { stderr: string }).stderr.trim()
        : (err as Error).message;
    return { applied: false, error: message };
  }
}

/** pure-ftpd bu sunucuda kurulu ve çalışıyor mu? Panel bunu tahmin etmez, bakar. */
export async function pureFtpdStatus(): Promise<{
  installed: boolean;
  running: boolean;
  note: string;
}> {
  let installed = false;
  try {
    await execFileAsync("sh", ["-c", "command -v pure-ftpd"]);
    installed = true;
  } catch {
    installed = false;
  }

  let running = false;
  try {
    const { stdout } = await execFileAsync("sh", ["-c", "ps -eo args 2>/dev/null | grep -c '[p]ure-ftpd'"]);
    running = Number(stdout.trim()) > 0;
  } catch {
    running = false;
  }

  const note = installed
    ? running
      ? "pure-ftpd çalışıyor."
      : "pure-ftpd kurulu ama çalışmıyor. Operatör servisi başlatmalı."
    : "pure-ftpd bu sunucuda kurulu değil. Hesaplar panelde kayıtlı ama FTP bağlantısı kabul edilmez.";

  return { installed, running, note };
}
