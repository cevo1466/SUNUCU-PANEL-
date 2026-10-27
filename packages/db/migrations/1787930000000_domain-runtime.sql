-- Up Migration
-- Domain başına çalışma zamanı (statik/PHP-FPM/reverse-proxy — ASP/.NET gibi
-- kendi sunucusunu ayağa kaldıran uygulamalar için) seçimi.

ALTER TABLE domains
    ADD COLUMN runtime_type VARCHAR(16) NOT NULL DEFAULT 'static';

ALTER TABLE domains
    ADD CONSTRAINT domains_runtime_type_check
    CHECK (runtime_type IN ('static', 'php', 'proxy'));

ALTER TABLE domains ADD COLUMN php_version VARCHAR(8);
ALTER TABLE domains ADD COLUMN proxy_port INT;

ALTER TABLE domains ADD CONSTRAINT domains_proxy_port_check
    CHECK (proxy_port IS NULL OR (proxy_port > 0 AND proxy_port < 65536));

-- Down Migration
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_proxy_port_check;
ALTER TABLE domains DROP COLUMN IF EXISTS proxy_port;
ALTER TABLE domains DROP COLUMN IF EXISTS php_version;
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_runtime_type_check;
ALTER TABLE domains DROP COLUMN IF EXISTS runtime_type;
