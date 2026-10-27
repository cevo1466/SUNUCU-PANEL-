-- Up Migration
-- Domain basina e-posta hesaplari (Dovecot passwd-file sanal kullanicilari).
--
-- DURUSTLUK NOTU: Bu sunucuda Postfix/Dovecot KURULU DEGIL. Tablo, kurulum
-- yapildiginda ops/generated/dovecot-users dosyasinin kaynagi olur. Panel
-- hicbir zaman "mail calisiyor" iddiasinda bulunmaz — mailServerStatus()
-- gercek kontrol yapar (binary + TCP port) ve durumu oldugu gibi soyler.
-- Ayni durustluk kurali FTP (pureFtpdStatus) ve MySQL (engineStatuses)
-- tarafinda da uygulaniyor.
--
-- ADRES NEDEN local_part + domain_id: Dovecot/Postfix'te kimligin kendisi
-- (domain, local_part) ciftidir; tam adres bu ciftten turetilir. Tam adresi
-- ayrica saklamak domains.domain_name ile IKINCI bir gercek kaynak yaratir ve
-- kayma riski dogururdu. ftp_accounts.username'in GLOBAL unique olmasinin
-- sebebi pure-ftpd'nin login alaninin duz olmasidir; mailde durum farkli:
-- ayni "info" farkli domainlerde bulunabilmelidir.
--
-- password_hash: openssl passwd -6 ciktisi (SHA-512 crypt, "$6$..."). Panel
-- KULLANICI parolalari argon2'dir (lib/password.ts, AGENTS.md Data kurali);
-- burada crypt kullanilmasinin sebebi Dovecot'un dogrulayabilecegi bir sema
-- gerekmesidir — ftp_accounts ile birebir ayni gerekce. Duz metin parola ne
-- bu tabloda ne ops/generated altinda tutulur; yalnizca uretildigi anda bir
-- kez API cevabinda doner.
CREATE TABLE mail_accounts (
    id SERIAL PRIMARY KEY,
    domain_id INT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    local_part VARCHAR(64) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    -- NULL = sinirsiz (ftp_accounts.quota_mb ile ayni sozlesme).
    -- YALNIZCA admin yazabilir (bkz. routes/mail.ts requireAdmin).
    quota_mb INT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mail_accounts_domain_local_part_key UNIQUE (domain_id, local_part),
    CONSTRAINT mail_accounts_quota_mb_check CHECK (quota_mb IS NULL OR quota_mb > 0)
);

CREATE INDEX idx_mail_accounts_domain_id ON mail_accounts(domain_id);

-- Domain basina VARSAYILAN kota. Kotayi yalnizca admin belirler; musteri hesap
-- actiginda kota alani gonderemez (403) ve hesap bu degeri devralir. Bu kolon
-- olmasaydi musterinin actigi her hesap sessizce SINIRSIZ dogardi ve
-- "kotayi admin belirlesin" istegi delinirdi.
ALTER TABLE domains ADD COLUMN mail_quota_default_mb INT;
ALTER TABLE domains ADD CONSTRAINT domains_mail_quota_default_mb_check
    CHECK (mail_quota_default_mb IS NULL OR mail_quota_default_mb > 0);

-- Down Migration
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_mail_quota_default_mb_check;
ALTER TABLE domains DROP COLUMN IF EXISTS mail_quota_default_mb;
DROP TABLE IF EXISTS mail_accounts;
