import * as dns from "node:dns/promises";
import { env } from "../env.js";
import { getCloudflareClient } from "./cloudflare.js";
import { resolveZoneForDomain } from "./dns-sync.js";

/**
 * Sertifika alinmadan ONCE gereken A kayitlarini hazirlar.
 *
 * NEDEN VAR: panel `www.` ve `webmail.` adlarini kendi veritabanina yaziyordu
 * ama domainin DNS saglayicisi "local" isaretliyse kayit yalnizca kimsenin
 * sunmadigi bir zone dosyasina gidiyordu. Gercek otorite Cloudflare'di, ad
 * hicbir zaman cozumlenmiyordu ve panel her seferinde "HTTPS yok" diyordu —
 * kullanicidan Cloudflare'e girip eli ile kayit acmasi bekleniyordu. Bu,
 * "tek tikla SSL" vaadinin sessizce yarim kalmasiydi.
 *
 * Artik SSL akisi eksik kaydi KENDISI aciyor. Cloudflare yapilandirilmamissa
 * ya da zone bulunamazsa sessizce gecmez; sebebini dondurur.
 */

export type HostPrepOutcome =
  | "zaten-var"      // ad cozumleniyor, dokunulmadi
  | "olusturuldu"    // kayit acildi ve cozumlenir hale geldi
  | "yayilmadi"      // kayit acildi ama henuz cozumlenmiyor
  | "cloudflare-yok" // token yok / zone bulunamadi
  | "ip-yok"         // SERVER_PUBLIC_IP tanimli degil
  | "hata";

export interface HostPrep {
  host: string;
  outcome: HostPrepOutcome;
  detail?: string;
}

/**
 * Ad GERCEKTEN var mi — otoriter sunucuya sorarak.
 *
 * YEREL COZUMLEYICIYE GUVENILEMEZ. Docker'in gomulu DNS'i negatif cevaplari
 * onbellege aliyor ve Cloudflare'in SOA minimum'u kadar (30 dakika) "yok"
 * demeye devam ediyor. Kayit Cloudflare'de acildiktan hemen sonra otoriter
 * sunucu dogru cevabi veriyorken yerel sorgu hala NXDOMAIN donuyordu ve
 * webmail sertifikasi hic kurulamiyordu (2026-09-02,
 * webmail.testsite.ornek.test).
 *
 * SOA, ad var olmasa bile ust bolgeden dondugu icin otoriter sunucuyu bu
 * yolla bulmak NXDOMAIN durumunda da calisir. ops/scripts/ssl-issue.sh
 * icindeki `resolves_host` AYNI mantigi kullaniyor; ikisi ayrisirsa API
 * "olusturuldu" derken script "cozumlenmiyor" der.
 */
async function resolves(host: string): Promise<boolean> {
  try {
    const soa = await dns
      .resolveSoa(host)
      .catch(async () => {
        // Ad yoksa SOA ust bolgeden gelir; parent'a soruyoruz.
        const parent = host.split(".").slice(1).join(".");
        return parent.includes(".") ? await dns.resolveSoa(parent) : null;
      })
      .catch(() => null);
    if (soa?.nsname) {
      const nsAddresses = await dns.resolve4(soa.nsname).catch(() => [] as string[]);
      if (nsAddresses.length > 0) {
        const authority = new dns.Resolver();
        authority.setServers(nsAddresses);
        const answers = await authority.resolve4(host).catch(() => [] as string[]);
        if (answers.length > 0) return true;
      }
    }
  } catch {
    // Otoriter sorgu yapilamadi; asagidaki yerel kontrole dusulur.
  }
  try {
    const found = await dns.lookup(host, { family: 4 });
    return Boolean(found.address);
  } catch {
    return false;
  }
}

/**
 * Kayit acildiktan sonra cozumlenmesini bekler.
 *
 * Cloudflare kenar sunucularina yayilim genelde saniyeler surer ama sistem
 * cozumleyicisinin NEGATIF onbellegi (NXDOMAIN) bundan uzun yasayabilir.
 * Bu yuzden BEKLEMEK yetmiyorsa "yayilmadi" deniyor ve islem durdurulmuyor —
 * certbot yine de denenir, cunku Let's Encrypt kendi cozumleyicisini kullanir
 * ve bizim onbellegimizi paylasmaz.
 */
async function waitForResolution(host: string, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await resolves(host)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/**
 * Tek bir alt alan adi icin A kaydini garanti eder.
 *
 * `proxied: false` BILINCLI: sertifika dogrulamasi ve mail/webmail trafigi
 * dogrudan sunucuya gelmeli. Cloudflare'in turuncu bulutu arkasinda kalan bir
 * webmail adresi, ucretsiz Universal SSL yalnizca tek seviye alt alan adini
 * kapsadigi icin cok seviyeli adlarda kenar TLS'inde duserdi.
 */
async function ensureHost(host: string, domainName: string): Promise<HostPrep> {
  if (await resolves(host)) return { host, outcome: "zaten-var" };

  const serverIp = env.SERVER_PUBLIC_IP;
  if (!serverIp) {
    return {
      host,
      outcome: "ip-yok",
      detail: "SERVER_PUBLIC_IP tanımlı değil; panel A kaydını kendisi oluşturamaz.",
    };
  }

  const client = getCloudflareClient();
  try {
    const { configured, zone } = await resolveZoneForDomain(client, domainName);
    if (!configured) {
      return { host, outcome: "cloudflare-yok", detail: "Cloudflare API token tanımlı değil." };
    }
    if (!zone) {
      return {
        host,
        outcome: "cloudflare-yok",
        detail: `${domainName} için Cloudflare'de bölge bulunamadı.`,
      };
    }

    // Kayit Cloudflare'de VARDIR ama henuz cozumlenmiyordur (yayilim) —
    // ikinci bir kayit acmak cakisma yaratir, once bakiyoruz.
    const existing = await client.listDnsRecords(zone.id);
    const already = existing.find((record) => record.name === host && record.type === "A");
    if (!already) {
      await client.createDnsRecord(zone.id, {
        type: "A",
        name: host,
        content: serverIp,
        ttl: 3600,
        proxied: false,
      });
    }

    // 20 sn yetmedi: Cloudflare kenar sunucularina yayilim hizli ama yerel
    // cozumleyicinin NEGATIF onbellegi (NXDOMAIN TTL'i) daha uzun yasiyor.
    // Gercek olcum: kayit acildiktan ~60 sn sonra her yerden cozumlendi.
    const ok = await waitForResolution(host, 75);
    return {
      host,
      outcome: ok ? "olusturuldu" : "yayilmadi",
      detail: ok
        ? undefined
        : "Kayıt açıldı ama henüz her yerde çözümlenmiyor; birkaç dakika sonra tekrar deneyin.",
    };
  } catch (err) {
    return { host, outcome: "hata", detail: (err as Error).message };
  }
}

/**
 * SSL icin gereken tum adlari hazirlar: `www.` ve `webmail.`.
 *
 * Alan adinin kendisi HAZIRLANMAZ — o zaten kullanicinin yonlendirdigi ad ve
 * panel onu degistirmemeli.
 */
export async function prepareSslHosts(domainName: string): Promise<HostPrep[]> {
  const hosts = domainName.startsWith("www.")
    ? [`webmail.${domainName}`]
    : [`www.${domainName}`, `webmail.${domainName}`];
  const results: HostPrep[] = [];
  for (const host of hosts) {
    results.push(await ensureHost(host, domainName));
  }
  return results;
}
