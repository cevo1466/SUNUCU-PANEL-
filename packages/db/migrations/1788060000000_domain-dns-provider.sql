-- Up Migration
-- Domain eklenirken "hangi DNS otoritesini kullanacağız" hiç sorulmuyordu —
-- panel öneri kayıtları sessizce sadece yerel dns_records'a yazıyor, admin
-- ayrı ayrı "Cloudflare'e Gönder" / "Zone oluştur ve uygula" butonlarına
-- basmadıkça hiçbir yere uygulanmıyordu. Bu sütun domain oluşturma formunda
-- yapılan seçimi kalıcı kılar; 'none' = henüz seçilmedi/elle yönetilecek
-- (mevcut satırlar ve eski davranış), 'local' = yerel BIND9, 'cloudflare' =
-- Cloudflare. Seçime göre routes/domains.ts oluşturma sırasında otomatik
-- push/apply tetikler (bkz. lib/dnsProvision.ts).
ALTER TABLE domains
  ADD COLUMN dns_provider VARCHAR(20) NOT NULL DEFAULT 'none';

-- Down Migration
ALTER TABLE domains DROP COLUMN IF EXISTS dns_provider;
