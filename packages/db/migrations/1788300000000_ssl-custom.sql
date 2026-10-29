-- Up Migration
-- Ucretli (ticari) CA sertifikasi destegi. `ssl_type` nginx'in HANGI sertifikayi
-- sundugunu soyler: 'letsencrypt' (certbot, /etc/letsencrypt/live) veya 'custom'
-- (panelden yuklenen CRT+CA paketi, /etc/letsencrypt/custom). Ayrim gerekli
-- cunku ssl-renew.sh yalnizca certbot sertifikalarini yeniler; ozel
-- sertifikanin suresini CA'dan elle yenilemek gerekir ve panel bunu
-- "Let's Encrypt otomatik yeniler" diye gostermemeli.

ALTER TABLE domains
  ADD COLUMN ssl_type TEXT NOT NULL DEFAULT 'letsencrypt'
    CHECK (ssl_type IN ('letsencrypt', 'custom')),
  ADD COLUMN ssl_issuer TEXT;

-- Down Migration
ALTER TABLE domains
  DROP COLUMN IF EXISTS ssl_issuer,
  DROP COLUMN IF EXISTS ssl_type;
