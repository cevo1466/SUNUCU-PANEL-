-- Up Migration
-- Webmail oturumlari — panel oturumlarindan TAMAMEN AYRI.
--
-- NEDEN AYRI TABLO (ve ayri cerez): webmail'e giren kimlik bir PANEL
-- KULLANICISI DEGIL, bir POSTA KUTUSUDUR (info@musteri.test). Ikisini ayni
-- `sessions` tablosunda tutmak, tek bir kolon karisikligiyla bir posta kutusu
-- sahibine panel yetkisi vermek demekti. Ayri tablo + ayri cerez adi
-- (`studio_webmail`) bu karisikligi SEMA DUZEYINDE imkansiz kilar:
-- `sessions.user_id` users'a, `webmail_sessions.mail_account_id`
-- mail_accounts'a bakar; birinin token'i otekinde ARANAMAZ.
--
-- PAROLA NEDEN BURADA: IMAP her istekte yeniden kimlik dogrular; oturum
-- suresince kullanicinin parolasini bir yerde tutmak zorundayiz. Duz metin
-- SAKLANMAZ — sunucu tarafinda uretilen bir anahtarla sifrelenir
-- (apps/api/src/lib/webmail-crypt.ts) ve yalnizca IMAP/SMTP baglantisi
-- kurulurken cozulur. Alternatif (parolayi cerezde tasimak) onu tarayiciya ve
-- her isteğe yayardi; alternatif (hic saklamamak) her sayfa yenilemede yeniden
-- giris istemek demekti.
CREATE TABLE webmail_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mail_account_id INT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    -- IMAP/SMTP icin gereken parola, sunucu anahtariyla sifrelenmis halde.
    -- Formati: base64(iv):base64(authTag):base64(ciphertext) — AES-256-GCM.
    secret_enc TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webmail_sessions_account ON webmail_sessions(mail_account_id);
CREATE INDEX idx_webmail_sessions_expires ON webmail_sessions(expires_at);

-- Down Migration
DROP TABLE IF EXISTS webmail_sessions;
