import type { Pool } from "pg";
import type { CloudflareClient, CloudflareZone } from "./cloudflare.js";

// AGENTS.md § Modül 2: "Cloudflare'deki güncel durumları panel veri
// tabanına çeken bir cron/job mekanizması." Bu dosya SADECE Cloudflare'i
// OKUR, panele YAZAR — gerçek hesaba karşı güvenle çalıştırılabilir/test
// edilebilir (guard.json'daki onay şartı DNS kaydı EKLEME/DEĞİŞTİRME/SİLME
// için; salt-okunur listeleme değil).

export interface ZoneResolution {
  configured: boolean;
  zone: CloudflareZone | null;
}

// Cloudflare'de "zone" = kayıtlı KÖK domain (örn. diger.test). Panelde
// domainler kendi zone_id'sini saklamıyor (verilen şemada böyle bir kolon
// yok) — bunun yerine isimle GERÇEK zamanlı çözülüyor. Zone yeniden
// adlandırılırsa/taşınırsa panel tarafında hiçbir şey güncellenmesi gerekmez.
//
// BUG (2026-08-28): önceki hâli `listZones(domainName)` ile TAM eşleşme
// arıyordu. Cloudflare'de zone'lar yalnızca kök seviyede var olabilir; panele
// "test.diger.test" gibi bir ALT alan adı eklendiğinde Cloudflare'de asla
// o isimde bir zone bulunmaz (kayıtlı zone "diger.test"dur), sonuç hep
// "zone_not_found" oluyordu — DNS sekmesi ve dolayısıyla (A kaydı yoksa)
// Let's Encrypt HTTP doğrulaması da bu yüzden çalışmıyordu. Şimdi tüm
// zone'lar çekilip domainName'in kendisiyle ya da bir zone'un ".<zone>" ile
// bittiği en UZUN (en spesifik) eşleşme bulunuyor.
export async function resolveZoneForDomain(
  client: CloudflareClient,
  domainName: string,
): Promise<ZoneResolution> {
  if (!client.isConfigured) return { configured: false, zone: null };
  const zones = await client.listZones();
  let best: CloudflareZone | null = null;
  for (const zone of zones) {
    const matches = domainName === zone.name || domainName.endsWith(`.${zone.name}`);
    if (matches && (!best || zone.name.length > best.name.length)) best = zone;
  }
  return { configured: true, zone: best };
}

export interface PullResult {
  configured: boolean;
  zoneFound: boolean;
  zoneName?: string;
  pulled: number;
}

export async function pullDnsRecordsFromCloudflare(
  pg: Pool,
  client: CloudflareClient,
  domainId: number,
  domainName: string,
): Promise<PullResult> {
  const { configured, zone } = await resolveZoneForDomain(client, domainName);
  if (!configured) return { configured: false, zoneFound: false, pulled: 0 };
  if (!zone) return { configured: true, zoneFound: false, pulled: 0 };

  const records = await client.listDnsRecords(zone.id);
  for (const r of records) {
    const existing = await pg.query(
      `SELECT id FROM dns_records WHERE domain_id = $1 AND cloudflare_id = $2`,
      [domainId, r.id],
    );
    if (existing.rows.length > 0) {
      await pg.query(
        `UPDATE dns_records
            SET record_type = $1, name = $2, content = $3, ttl = $4, synced_at = NOW()
          WHERE id = $5`,
        [r.type, r.name, r.content, r.ttl, existing.rows[0].id],
      );
    } else {
      await pg.query(
        `INSERT INTO dns_records (domain_id, record_type, name, content, ttl, cloudflare_id, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [domainId, r.type, r.name, r.content, r.ttl, r.id],
      );
    }
  }
  return { configured: true, zoneFound: true, zoneName: zone.name, pulled: records.length };
}
