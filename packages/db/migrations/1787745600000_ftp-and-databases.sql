-- Up Migration
-- FTP hesapları ve domain başına PostgreSQL veritabanları.

-- pure-ftpd SANAL kullanıcıları. Linux sistem hesabı açılmaz; tüm sanal
-- kullanıcılar /var/www/vhosts sahibinin uid/gid'ine eşlenir ve kendi domain
-- dizinine chroot edilir.
--
-- password_hash: openssl passwd -6 çıktısı (SHA-512 crypt). Düz metin parola
-- ne bu tabloda ne de ops/generated/ altında hiçbir yerde tutulmaz; parola
-- yalnızca üretildiği anda bir kez kullanıcıya gösterilir.
CREATE TABLE ftp_accounts (
    id SERIAL PRIMARY KEY,
    domain_id INT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    home_dir VARCHAR(512) NOT NULL,
    quota_mb INT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ftp_accounts_domain_id ON ftp_accounts(domain_id);

-- Panelin oluşturduğu gerçek PostgreSQL veritabanları.
--
-- Rol parolası BURADA TUTULMAZ: parola PostgreSQL'in kendi rol kaydında yaşar
-- ve panel onu geri okuyamaz. Kullanıcı parolayı kaybederse sıfırlanır.
-- db_name/db_user Postgres tanımlayıcısı olduğu için ^[a-z][a-z0-9_]{0,62}$
-- kalıbıyla uygulama katmanında doğrulanır.
CREATE TABLE panel_databases (
    id SERIAL PRIMARY KEY,
    domain_id INT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    db_name VARCHAR(63) UNIQUE NOT NULL,
    db_user VARCHAR(63) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_panel_databases_domain_id ON panel_databases(domain_id);

-- Down Migration
DROP TABLE IF EXISTS panel_databases;
DROP TABLE IF EXISTS ftp_accounts;
