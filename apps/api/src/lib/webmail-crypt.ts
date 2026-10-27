import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GENERATED_DIR } from "./domain.js";

/**
 * Webmail oturum sırlarının şifrelenmesi.
 *
 * NEDEN VAR: webmail'de her IMAP/SMTP isteği kullanıcının parolasını gerektirir
 * — IMAP oturum kavramı bizim oturumumuzla aynı ömre sahip değil. Parolayı bir
 * yerde tutmak zorundayız. Üç seçenek vardı:
 *   1. Çerezde taşımak → parola her istekte tarayıcıya ve ağa yayılır, XSS'te
 *      doğrudan sızar. ELENDİ.
 *   2. Hiç saklamamak → her sayfa yenilemesinde yeniden giriş. Kullanılamaz.
 *   3. Sunucuda, sunucu anahtarıyla şifreli saklamak. SEÇİLEN.
 *
 * Seçilen yol parolayı veritabanında düz metin bırakmaz: AES-256-GCM ile
 * şifrelenir. Veritabanı yedeği sızsa bile anahtar dosyası olmadan çözülemez.
 * Anahtar dosyası 0600 izinle ops/generated altında durur.
 *
 * GCM ÖZELLİKLE SEÇİLDİ (CBC değil): kimlik doğrulamalı şifreleme, yani
 * bozulmuş/oynanmış bir kayıt sessizce yanlış parola üretmez, çözme AŞAMASINDA
 * hata verir. Yanlış parolayla IMAP'e gitmek hesabı kilitleyebilirdi.
 */

const KEY_PATH = path.join(GENERATED_DIR, "webmail-secret.key");
const ALGORITHM = "aes-256-gcm";

let cachedKey: Buffer | null = null;

/**
 * Sunucu anahtarı. Yoksa üretilir (idempotent).
 *
 * Anahtar `.env` yerine dosyada: `.env.loopkit` git'e girmiyor ama operatör
 * tarafından sık sık okunup düzenleniyor; bir şifreleme anahtarının orada
 * gözle görünür durması gereksiz bir yayılım. Dosya 0600 ve yalnızca bu
 * modül okuyor.
 */
function serverKey(): Buffer {
  if (cachedKey) return cachedKey;
  try {
    const raw = fs.readFileSync(KEY_PATH, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) {
      cachedKey = key;
      return key;
    }
    // Yanlış uzunluk = bozuk dosya. Sessizce yeni anahtar üretmek TÜM açık
    // oturumları çözülemez hale getirirdi; bunu gürültüyle söylüyoruz.
    throw new Error(`webmail-secret.key bozuk (${key.length} bayt, 32 bekleniyor).`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, key.toString("base64"), { mode: 0o600 });
  cachedKey = key;
  return key;
}

/** Test için: önbelleği düşürür (anahtar dosyası değiştiyse). */
export function resetWebmailKeyCache(): void {
  cachedKey = null;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, serverKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/**
 * @throws Bozuk/oynanmış kayıtta hata fırlatır — sessizce boş parola dönmez.
 */
export function decryptSecret(stored: string): string {
  const parts = String(stored).split(":");
  if (parts.length !== 3) throw new Error("Şifreli sır biçimi geçersiz.");
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    serverKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
