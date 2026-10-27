-- Up Migration
-- Yedekleme ve GERI YUKLEME DOGRULAMA kayitlari.
--
-- NEDEN VAR: bu tablodan once panelin yedekleme "yetenegi" diskteki bir
-- dosyadan ibaretti. Dosyanin varligi hicbir sey kanitlamaz — arsiv bozuk
-- olabilir, icinde veritabani dump'i olmayabilir, geri yuklendiginde site
-- ayaga kalkmayabilir. Panelin baska yerlerindeki durustluk kurali burada da
-- gecerli: bir yedegi "iyi" diye gostermek icin GERCEKTEN geri yuklenebildigi
-- kanitlanmis olmali (bkz. backup-verify).
--
-- Bu tablo yedegin KENDISINI tutmaz (o diskte, ops/backups altinda);
-- yalnizca her calismanin ne yaptigini ve dogrulamanin sonucunu tutar.
CREATE TABLE backup_runs (
    id SERIAL PRIMARY KEY,
    -- Domain SILINSE BILE kayit kalir: "su tarihte yedegi vardi" bilgisi,
    -- domain gittikten sonra daha da degerlidir. Bu yuzden FK yok, ad tutulur.
    domain_name VARCHAR(255) NOT NULL,
    -- "domain" = tek bir alan adinin anlik goruntusu,
    -- "panel-state" = panelin kendi veritabani + uretilmis dosyalari.
    kind VARCHAR(20) NOT NULL DEFAULT 'domain',
    -- ops/backups altindaki dosya adi (dizin degil) — tam yol yapilandirmadan
    -- turetilir, tasinabilir kalsin.
    archive_name VARCHAR(255) NOT NULL,
    size_bytes BIGINT,
    -- Manifest ozeti: kac dosya, hangi parcalar var (files/db/dns/dkim...).
    manifest JSONB,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    -- running | ok | failed
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    error TEXT,

    -- --- Dogrulama (geri yukleme testi) ---
    -- NULL = hic denenmedi. Panel bunu "dogrulanmadi" diye gosterir, YESIL
    -- gostermez: denenmemis yedek, calisir yedek DEGILDIR.
    verified_at TIMESTAMP,
    verify_status VARCHAR(20),   -- ok | failed
    verify_error TEXT,
    -- Dogrulamada gercekten neyin denendigi (arsiv acildi mi, SQL yuklendi mi).
    verify_detail JSONB,

    CONSTRAINT backup_runs_kind_check CHECK (kind IN ('domain', 'panel-state')),
    CONSTRAINT backup_runs_status_check CHECK (status IN ('running', 'ok', 'failed')),
    CONSTRAINT backup_runs_verify_status_check
        CHECK (verify_status IS NULL OR verify_status IN ('ok', 'failed'))
);

CREATE INDEX idx_backup_runs_domain ON backup_runs(domain_name, started_at DESC);
-- Rotasyon "son DOGRULANMIS yedegi asla silme" kuralini uyguluyor; bu indeks
-- o sorguyu ucuzlatir.
CREATE INDEX idx_backup_runs_verified ON backup_runs(domain_name, verify_status, started_at DESC);

-- Down Migration
DROP TABLE IF EXISTS backup_runs;
