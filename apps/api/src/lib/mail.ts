import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";
import { GENERATED_DIR, domainRootPath } from "./domain.js";
import { sha512Crypt } from "./crypt.js";
import { isPortOpen } from "./net.js";
import { PROJECT_ROOT } from "../env.js";

const execFileAsync = promisify(execFile);
const MAIL_CTL_SCRIPT = path.join(PROJECT_ROOT, "ops", "scripts", "mail-ctl.sh");

/**
 * E-posta hesapları — Dovecot SANAL kullanıcıları.
 *
 * DÜRÜSTLÜK NOTU (AGENTS.md kuralı): Bu sunucuda Postfix/Dovecot KURULU
 * DEĞİL ve hiçbir mail portu dinlenmiyor. Panel burada hesap tanımlarını ve
 * admin'in belirlediği kotaları yönetir, Dovecot'un okuyabileceği
 * `ops/generated/dovecot-users` dosyasını üretir — ama e-posta gönderilip
 * alındığı iddiasında BULUNMAZ. `mailServerStatus()` gerçek kontrol yapar
 * (binary + TCP port) ve sonucu olduğu gibi söyler. Aynı desen pure-ftpd
 * (ftp.ts pureFtpdStatus) ve MariaDB (databases.ts engineStatuses) için de
 * uygulanıyor.
 */

export class MailError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const DOVECOT_USERS_PATH = path.join(GENERATED_DIR, "dovecot-users");
/** Postfix `hash:` tablosu — sadece etkin e-posta hesabı olan domainler için
 * RCPT TO kabul edilir (bkz. PROD-DEPLOYMENT.md §6c). writeDovecotUsers ile
 * AYNI sorgudan üretilir, ikisi hep birlikte yeniden yazılır. */
export const POSTFIX_VMAILBOX_DOMAINS_PATH = path.join(GENERATED_DIR, "postfix-vmailbox-domains");

/** Kota gönderilmemişse ve domain varsayılanı da yoksa uygulanan değer. */
export const DEFAULT_QUOTA_MB = 256;

/**
 * RFC 5321 dot-atom'ın DAR bir alt kümesi — bilinçli olarak kısıtlı.
 * Geniş tutulsaydı (tırnaklı local-part, unicode, ":" ) hem Dovecot'un
 * passwd-file ayrıştırıcısı (satırı ":" ile böler) hem de maildir yolu
 * sürprizlerle karşılaşırdı.
 */
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function normalizeLocalPart(raw: string): string {
  return raw.trim().toLowerCase();
}

export function assertValidLocalPart(localPart: string): void {
  if (!LOCAL_PART_PATTERN.test(localPart) || localPart.includes("..")) {
    throw new MailError(
      "Adresin @ öncesi kısmı 1-64 karakter olmalı; küçük harf, rakam, nokta, tire ve alt çizgi " +
        "içerebilir, nokta/tire ile başlayıp bitemez ve arka arkaya iki nokta olamaz.",
      400,
    );
  }
}

export function mailAddress(localPart: string, domainName: string): string {
  return `${localPart}@${domainName}`;
}

/** Kullanılmayan ilk yaygın adı önerir. */
export function suggestLocalPart(taken: string[]): string {
  const candidates = ["info", "destek", "iletisim", "posta", "yonetim"];
  const used = new Set(taken.map(normalizeLocalPart));
  return candidates.find((c) => !used.has(c)) ?? `kullanici${taken.length + 1}`;
}

/**
 * Parolayı SHA-512 crypt biçimine çevirir. Gövde lib/crypt.ts'te ortak;
 * burada yalnızca hata tipi MailError'a çevriliyor.
 */
export async function hashPassword(password: string): Promise<string> {
  try {
    return await sha512Crypt(password);
  } catch (err) {
    throw new MailError(`Parola hash'i üretilemedi: ${(err as Error).message}`, 500);
  }
}

export { generatePassword } from "./crypt.js";

/**
 * Posta kutusunun dosya sistemi yolu.
 *
 * `domainRootPath()` üzerinden gider: /var/www/vhosts dışına çıkan hiçbir yol
 * üretilemez (AGENTS.md § Security). `public/` ALTINDA DEĞİL — orada olsaydı
 * posta kutusu HTTP ile indirilebilirdi.
 *
 * Domain kökünün altında olduğu için domain silindiğinde mevcut karantina +
 * silme zinciri posta kutularını da kapsar; panelin tar.gz yedeğine de dahil
 * olur. Ayrı bir temizlik adımı gerekmez.
 */
export function maildirPath(domainName: string, localPart: string): string {
  return path.join(domainRootPath(domainName), "mail", localPart);
}

export interface MailAccountRow {
  id: number;
  domain_id: number;
  local_part: string;
  password_hash: string;
  quota_mb: number | null;
  enabled: boolean;
  created_at: Date;
  domain_name?: string;
}

/**
 * Dovecot `passwd-file` biçimindeki kullanıcı dosyasını üretir.
 *
 * Satır biçimi (8 alan, ":" ile ayrılmış):
 *   user : password : uid : gid : gecos : home : shell : extra_fields
 *
 * `extra_fields` SON alandır ve satırın kalanını yutar — bu yüzden
 * içindeki ":" karakterleri güvenlidir (`quota_rule=*:storage=256M`).
 * KRİTİK: bu alandan sonra başka alan EKLENMEMELİ, eklenirse kota sessizce
 * bozulur. Self-test bunu `storage=` iddiasıyla sabitliyor.
 *
 * Yalnızca `enabled = TRUE` hesaplar yazılır: kapatma işlemi girişi anında
 * keser (ftp.ts ile birebir aynı sözleşme).
 *
 * ATOMİK ve 0600: dosya parola hash'i taşır. Düz metin parola HİÇBİR zaman
 * diske yazılmaz.
 */
export async function writeDovecotUsers(
  pg: Pool | PoolClient,
  vhostsRoot: string,
): Promise<string> {
  const { rows } = await pg.query<{
    local_part: string;
    password_hash: string;
    quota_mb: number | null;
    domain_name: string;
  }>(
    `SELECT m.local_part, m.password_hash, m.quota_mb, d.domain_name
       FROM mail_accounts m
       JOIN domains d ON d.id = m.domain_id
      WHERE m.enabled = TRUE
      ORDER BY d.domain_name, m.local_part`,
  );

  // uid/gid, /var/www/vhosts'un MEVCUT sahibinden okunur — uydurma bir sistem
  // kullanıcısı açılmaz (ftp.ts ile aynı gerekçe). Operatör Dovecot'ta
  // mail_uid/mail_gid ile ezebilir; bkz. PROD-DEPLOYMENT.md §6c.
  const stat = await fs.stat(vhostsRoot);
  const uid = stat.uid;
  const gid = stat.gid;

  const lines = rows.map((row) => {
    const address = mailAddress(row.local_part, row.domain_name);
    const home = maildirPath(row.domain_name, row.local_part);
    // Dovecot 2.4, 2.3'ün `userdb_quota_rule=*:storage=NM` sözdiziminden
    // `userdb_quota_storage_size=NM`'e geçti (bkz. doc.dovecot.org/main/core/plugins/quota.html).
    const extra =
      row.quota_mb && row.quota_mb > 0 ? `userdb_quota_storage_size=${row.quota_mb}M` : "";
    return `${address}:{SHA512-CRYPT}${row.password_hash}:${uid}:${gid}::${home}::${extra}`;
  });

  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";

  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const tmp = `${DOVECOT_USERS_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, DOVECOT_USERS_PATH);
  await fs.chmod(DOVECOT_USERS_PATH, 0o600);

  const domains = [...new Set(rows.map((row) => row.domain_name))].sort();
  const domainsContent = domains.map((d) => `${d}\tOK`).join("\n") + (domains.length ? "\n" : "");
  const domainsTmp = `${POSTFIX_VMAILBOX_DOMAINS_PATH}.${process.pid}.tmp`;
  await fs.writeFile(domainsTmp, domainsContent, { mode: 0o644 });
  await fs.rename(domainsTmp, POSTFIX_VMAILBOX_DOMAINS_PATH);

  return DOVECOT_USERS_PATH;
}

/**
 * Postfix'in vmailbox-domains hash tablosunu (postmap) yeniden derler,
 * Postfix+Dovecot'u reload eder — pure-ftpd (ftp.ts) ve BIND (deploy-zone.sh)
 * ile aynı desen. Hesap değişikliği ancak bu çağrıyla devreye girer.
 */
export async function applyMailReload(): Promise<{ applied: boolean; error?: string }> {
  try {
    await execFileAsync("sudo", [MAIL_CTL_SCRIPT, "reload"], { timeout: 20_000 });
    return { applied: true };
  } catch (err) {
    const message =
      err && typeof err === "object" && "stderr" in err && (err as { stderr?: string }).stderr
        ? (err as { stderr: string }).stderr.trim()
        : (err as Error).message;
    return { applied: false, error: message };
  }
}

export interface MailPortStatus {
  label: string;
  port: number;
  open: boolean;
}

export interface MailServiceStatus {
  postfixInstalled: boolean;
  dovecotInstalled: boolean;
  installed: boolean;
  running: boolean;
  ports: MailPortStatus[];
  usersFile: string;
  note: string;
}

async function hasBinary(name: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mail sunucusunun gerçek durumu. "Kurulu mu" ile "çalışıyor mu" ayrı ayrı
 * raporlanır; panel bu ikisini karıştırıp sahte bir güven vermez.
 *
 * Port kontrolleri PARALEL yapılır: sırayla yapılsaydı en kötü durumda
 * 3 × 700 ms = 2.1 sn beklenirdi ve domain detay sayfasının sekme sayacı
 * gecikirdi.
 */
export async function mailServerStatus(): Promise<MailServiceStatus> {
  const [postfixInstalled, dovecotInstalled, smtp, submission, imaps] = await Promise.all([
    hasBinary("postfix"),
    hasBinary("dovecot"),
    isPortOpen("127.0.0.1", 25),
    isPortOpen("127.0.0.1", 587),
    isPortOpen("127.0.0.1", 993),
  ]);

  const ports: MailPortStatus[] = [
    { label: "SMTP", port: 25, open: smtp },
    { label: "Submission", port: 587, open: submission },
    { label: "IMAPS", port: 993, open: imaps },
  ];
  const installed = postfixInstalled || dovecotInstalled;
  const running = submission || imaps;

  let note: string;
  if (!installed) {
    note =
      "Postfix/Dovecot bu sunucuda kurulu değil; 25/587/993 portlarında dinleyen yok. " +
      "Hesaplar ve kotalar panelde kayıtlı tutulur ve dovecot-users dosyası üretilir — " +
      "ancak e-posta gönderilip alınamaz ve kotalar henüz UYGULANMAZ. " +
      "Kurulum root ister; adımlar: PROD-DEPLOYMENT.md §6c.";
  } else if (!running) {
    note =
      "Postfix/Dovecot kurulu ama 587/993 dinlenmiyor — servisler başlatılmamış. " +
      "Kotalar henüz uygulanmaz.";
  } else {
    note =
      "Submission (587) veya IMAPS (993) dinleniyor. Panelin ürettiği dovecot-users " +
      "dosyasının Dovecot'a bağlandığını `doveadm auth test` ile doğrulayın.";
  }

  return {
    postfixInstalled,
    dovecotInstalled,
    installed,
    running,
    ports,
    usersFile: DOVECOT_USERS_PATH,
    note,
  };
}
