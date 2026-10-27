-- Up Migration
-- MX kaydı önceliği (priority) ve SRV kaydı (weight/port) alanları için.
-- Domain eklenince otomatik DNS önerisi (A/CNAME/MX/SPF/DKIM/DMARC/SRV)
-- özelliğinin bir parçası. Nullable — sadece MX/SRV kayıtları kullanır,
-- mevcut A/CNAME/TXT satırları etkilenmez.

ALTER TABLE dns_records
  ADD COLUMN priority INTEGER,
  ADD COLUMN weight INTEGER,
  ADD COLUMN port INTEGER;

-- Down Migration
ALTER TABLE dns_records DROP COLUMN IF EXISTS priority;
ALTER TABLE dns_records DROP COLUMN IF EXISTS weight;
ALTER TABLE dns_records DROP COLUMN IF EXISTS port;
