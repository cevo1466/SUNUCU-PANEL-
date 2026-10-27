import crypto from "node:crypto";
import type { Pool } from "pg";
import { env } from "../env.js";
import { encryptSecret, decryptSecret } from "./webmail-crypt.js";

/**
 * Webmail oturumu — panel oturumundan AYRI.
 *
 * Çerez adı bilinçli olarak farklı (`studio_webmail` vs `studio_session`).
 * Aynı adı kullansaydık tek bir tarayıcıda ikisi birbirini ezerdi ve daha
 * kötüsü: panelin `requireAuth`'u webmail çerezini görüp `sessions` tablosunda
 * arardı. Ayrı ad + ayrı tablo, bu karışıklığı imkânsız kılar.
 */
export const WEBMAIL_COOKIE_NAME = "studio_webmail";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface WebmailIdentity {
  sessionId: string;
  accountId: number;
  /** Tam adres: info@musteri.test */
  address: string;
  domainId: number;
  domainName: string;
  localPart: string;
  quotaMb: number | null;
  /** IMAP/SMTP için çözülmüş parola. Log'a ASLA yazılmaz. */
  password: string;
}

export async function createWebmailSession(
  pg: Pool,
  accountId: number,
  password: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + env.WEBMAIL_SESSION_HOURS * 3600 * 1000);
  await pg.query(
    `INSERT INTO webmail_sessions (mail_account_id, token_hash, secret_enc, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [accountId, hashToken(token), encryptSecret(password), expiresAt],
  );
  return { token, expiresAt };
}

/**
 * Token'ı kimliğe çevirir. Süresi dolmuş veya devre dışı bırakılmış hesap
 * null döner.
 *
 * `enabled = false` KONTROLÜ BURADA: admin bir posta kutusunu kapattığında
 * açık webmail oturumu da anında geçersiz olmalı. Yalnızca girişte kontrol
 * etseydik, kapatılan hesap oturumu bitene kadar (12 saat) mail okumaya
 * devam ederdi.
 */
export async function resolveWebmailSession(
  pg: Pool,
  token: string,
): Promise<WebmailIdentity | null> {
  const { rows } = await pg.query<{
    id: string;
    mail_account_id: number;
    secret_enc: string;
    local_part: string;
    quota_mb: number | null;
    domain_id: number;
    domain_name: string;
  }>(
    `SELECT s.id, s.mail_account_id, s.secret_enc,
            m.local_part, m.quota_mb, m.domain_id, d.domain_name
       FROM webmail_sessions s
       JOIN mail_accounts m ON m.id = s.mail_account_id
       JOIN domains d ON d.id = m.domain_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
        AND m.enabled = TRUE`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;

  let password: string;
  try {
    password = decryptSecret(row.secret_enc);
  } catch {
    // Anahtar değişmiş veya kayıt bozulmuş: oturumu geçersiz say ve temizle.
    // Bozuk parolayla IMAP'e gitmek hesabı kilitleyebilirdi.
    await pg.query("DELETE FROM webmail_sessions WHERE id = $1", [row.id]);
    return null;
  }

  // Son görülme, boşta kalan oturumların temizliği için. Her istekte UPDATE
  // yazmamak adına yalnızca bir dakikadan eskiyse güncellenir.
  await pg.query(
    "UPDATE webmail_sessions SET last_seen_at = NOW() WHERE id = $1 AND last_seen_at < NOW() - INTERVAL '1 minute'",
    [row.id],
  );

  return {
    sessionId: row.id,
    accountId: row.mail_account_id,
    address: `${row.local_part}@${row.domain_name}`,
    domainId: row.domain_id,
    domainName: row.domain_name,
    localPart: row.local_part,
    quotaMb: row.quota_mb,
    password,
  };
}

export async function destroyWebmailSession(pg: Pool, token: string): Promise<string | null> {
  const { rows } = await pg.query<{ id: string }>(
    "DELETE FROM webmail_sessions WHERE token_hash = $1 RETURNING id",
    [hashToken(token)],
  );
  return rows[0]?.id ?? null;
}

/** Süresi dolmuş oturumları siler. Girişte çağrılır — ayrı bir cron gerekmez. */
export async function pruneExpiredWebmailSessions(pg: Pool): Promise<void> {
  await pg.query("DELETE FROM webmail_sessions WHERE expires_at < NOW()");
}
