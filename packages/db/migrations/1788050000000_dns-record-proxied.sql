-- Up Migration
-- Cloudflare proxy durumu (turuncu bulut) su ana kadar HIC PERSIST edilmiyordu
-- — toCloudflarePayload() her zaman `record.proxied ?? false` dustugu icin
-- panel araciligiyla eklenen HICBIR kayit gercekte proxied:true olarak
-- Cloudflare'e gonderilemiyordu (istemci proxied:true gonderse bile DB'ye
-- hic yazilmadigi icin sonraki her guncelleme/push'ta sessizce false'a
-- donuyordu). Bu sutun eksikligi 2026-08-28'de DNS sablon motoru
-- genisletilirken bulundu.

ALTER TABLE dns_records
  ADD COLUMN proxied BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration
ALTER TABLE dns_records DROP COLUMN IF EXISTS proxied;
