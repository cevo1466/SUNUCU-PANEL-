import * as dns from "node:dns/promises";
import type { Pool } from "pg";
import { getCloudflareClient } from "./cloudflare.js";
import { resolveZoneForDomain } from "./dns-sync.js";
import { toCloudflarePayload } from "./dnsProvision.js";
import { autoconfigLeftovers, findDnsConflicts } from "./dns-conflicts.js";

/**
 * Posta DNS kayitlarinin GERCEK durumu ve eksiklerin tamamlanmasi.
 *
 * NEDEN VAR (2026-09-02): panel yeni bir domain icin MX, SPF, DKIM ve DMARC
 * kayitlarini PLANLIYOR ve kendi veritabanina yaziyordu — ama domainin DNS
 * saglayicisi "local" isaretliyse bu kayitlar yalnizca kimsenin sunmadigi bir
 * zone dosyasina gidiyordu. Gercek otorite Cloudflare'di. Sonuc, iki yonun de
 * kirilmasiydi:
 *   - MX yok  -> disaridan gelen posta teslim edilemez
 *   - SPF/DKIM/DMARC yok -> giden posta "gonderen dogrulanamadi" damgasi yer
 * Ikisi de sessizdi: panel kayitlari listeliyordu, gercekte hicbiri yoktu.
 *
 * Bu modul KAYDA DEGIL DNS'E bakar. Bu projede tekrar eden hata sinifi tam
 * olarak "kayit X diyor, gercek Y".
 */

/** Postanin calismasi icin gereken kayitlar. */
const MAIL_RECORD_KINDS = ["mail-a", "mx", "spf", "dkim", "dmarc"] as const;
export type MailRecordKind = (typeof MAIL_RECORD_KINDS)[number];

export type MailDnsState = "var" | "eksik" | "bakilamadi";

export interface MailDnsEntry {
  kind: MailRecordKind;
  /** Kullaniciya gosterilecek ad. */
  label: string;
  /** Sorgulanan ad. */
  host: string;
  state: MailDnsState;
  /** DNS'te bulunan deger (kisaltilmis). */
  found?: string;
  /** Neden bakilamadi. */
  error?: string;
}

export interface MailDnsReport {
  entries: MailDnsEntry[];
  /** Hepsi yerindeyse true. */
  complete: boolean;
  /** Eksik kayit sayisi. */
  missing: number;
}

/**
 * Otoriter sunucudan sorar.
 *
 * YEREL COZUMLEYICI KULLANILMAZ: Docker'in gomulu DNS'i negatif cevaplari
 * SOA minimum'u kadar (Cloudflare'de 30 dk) onbellekte tutuyor. Kayit yeni
 * acildiginda yerel sorgu hala "yok" der ve panel eksik gorunur — bu tam
 * olarak webmail sertifikasinda yasandi (bkz. lib/ssl-dns.ts).
 */
async function authorityFor(host: string): Promise<string[] | null> {
  const soa = await dns
    .resolveSoa(host)
    .catch(async () => {
      const parent = host.split(".").slice(1).join(".");
      return parent.includes(".") ? await dns.resolveSoa(parent) : null;
    })
    .catch(() => null);
  if (!soa?.nsname) return null;
  const addresses = await dns.resolve4(soa.nsname).catch(() => [] as string[]);
  return addresses.length > 0 ? addresses : null;
}

async function query(
  host: string,
  type: "A" | "MX" | "TXT",
  match: (value: string) => boolean,
): Promise<{ state: MailDnsState; found?: string; error?: string }> {
  const servers = await authorityFor(host);
  const resolver = new dns.Resolver();
  if (servers) resolver.setServers(servers);
  try {
    if (type === "A") {
      const found = await resolver.resolve4(host);
      return found.length > 0 ? { state: "var", found: found[0] } : { state: "eksik" };
    }
    if (type === "MX") {
      const found = await resolver.resolveMx(host);
      const hit = found.find((record) => match(record.exchange));
      return hit ? { state: "var", found: `${hit.priority} ${hit.exchange}` } : { state: "eksik" };
    }
    const found = await resolver.resolveTxt(host);
    const flat = found.map((chunks) => chunks.join(""));
    const hit = flat.find(match);
    return hit ? { state: "var", found: hit.slice(0, 60) } : { state: "eksik" };
  } catch (err) {
    const code = (err as { code?: string }).code;
    // ENOTFOUND/ENODATA = kayit yok (hata degil). Digerleri gercek arizadir
    // ve "eksik" diye gostermek yaniltir — kullanici olmayan bir sorunu
    // duzeltmeye calisir.
    if (code === "ENOTFOUND" || code === "ENODATA") return { state: "eksik" };
    return { state: "bakilamadi", error: code ?? (err as Error).message };
  }
}

/** DNS'in GERCEK durumunu olcer. */
export async function checkMailDns(domainName: string): Promise<MailDnsReport> {
  const mailHost = `mail.${domainName}`;
  const entries: MailDnsEntry[] = [];

  const checks: Array<[MailRecordKind, string, string, "A" | "MX" | "TXT", (v: string) => boolean]> = [
    ["mail-a", "Posta sunucusu (mail. A)", mailHost, "A", () => true],
    ["mx", "MX kaydı", domainName, "MX", (v) => v.replace(/\.$/, "") === mailHost],
    ["spf", "SPF", domainName, "TXT", (v) => /^v=spf1\b/i.test(v)],
    ["dkim", "DKIM", `default._domainkey.${domainName}`, "TXT", (v) => /^v=DKIM1\b/i.test(v)],
    ["dmarc", "DMARC", `_dmarc.${domainName}`, "TXT", (v) => /^v=DMARC1\b/i.test(v)],
  ];

  for (const [kind, label, host, type, match] of checks) {
    const result = await query(host, type, match);
    entries.push({ kind, label, host, ...result });
  }

  const missing = entries.filter((entry) => entry.state === "eksik").length;
  return { entries, complete: missing === 0, missing };
}

export interface MailDnsFixResult {
  /** Cloudflare'e yazilan kayit sayisi. */
  created: number;
  /** Yazilamayanlar ve sebebi. */
  failed: Array<{ name: string; error: string }>;
  /** Devralinirken KALDIRILAN eski kayitlar — ne yapildigi gizlenmez. */
  removed: string[];
  /** Yazildi ama dikkat isteyen durumlar (ornegin apeks A eski sunucuda). */
  warnings: string[];
  /** Cloudflare kullanilamiyorsa sebebi. */
  unavailable?: string;
}

/**
 * Panelin PLANLADIGI posta kayitlarini gercek DNS saglayicisina yazar.
 *
 * Panelin kendi `dns_records` tablosu kaynak alinir: oradaki degerler zaten
 * dogru hesaplanmis (gercek DKIM genel anahtari, sunucunun IP'si, SPF).
 * Yeniden uretmek ikinci bir dogruluk kaynagi yaratirdi.
 *
 * DEVRALMA: baska saglayicidan gelen bolgede posta kayitlarinin onunu tikayan
 * eski kayitlar (mail. CNAME, yabanci MX, ikinci SPF) KALDIRILIR — sinirlari
 * ve gerekcesi icin bkz. lib/dns-conflicts.ts. Web kayitlarina dokunulmaz.
 * Kaldirilan her kayit `removed` icinde tam degeriyle bildirilir; geri almak
 * isteyen ayni degeri DNS sayfasindan yeniden ekleyebilir.
 */
export async function ensureMailDns(
  pg: Pool,
  domainId: number,
  domainName: string,
): Promise<MailDnsFixResult> {
  const client = getCloudflareClient();
  const { configured, zone } = await resolveZoneForDomain(client, domainName);
  if (!configured) {
    return {
      created: 0,
      failed: [],
      removed: [],
      warnings: [],
      unavailable: "Cloudflare API token tanımlı değil.",
    };
  }
  if (!zone) {
    return {
      created: 0,
      failed: [],
      removed: [],
      warnings: [],
      unavailable: `${domainName} için Cloudflare'de bölge bulunamadı.`,
    };
  }

  const mailHost = `mail.${domainName}`;
  const { rows } = await pg.query(
    `SELECT id, record_type, name, content, ttl, priority, proxied, cloudflare_id
       FROM dns_records
      WHERE domain_id = $1
        AND (name = $2 OR name = $3 OR name = $4 OR name = $5)
        AND record_type IN ('A','MX','TXT')`,
    [domainId, mailHost, domainName, `default._domainkey.${domainName}`, `_dmarc.${domainName}`],
  );

  let live = await client.listDnsRecords(zone.id);
  const created: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const removed: string[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const { exists, conflicts } = findDnsConflicts(row, live, domainName);

    // ONEMLI: `exists` kontrolu devralmadan ONCE yapilmaz. Panelin MX'i
    // yerinde olsa bile eski saglayicinin MX'i duruyor olabilir; o kayit
    // kaldirilmazsa gelen postanin yarisi eski sunucuya gitmeye devam eder
    // ve panel "eksik kayit yok" der (kullanicinin 2026-09-05'te yasadigi
    // durumun sessiz yarisi).

    // Devralinabilir engelleri KALDIR. Yalnizca posta kayitlari; apeks A ve
    // www hicbir kosulda buraya girmez (bkz. dns-conflicts.ts isMailScoped).
    let takeoverFailed = false;
    for (const conflict of conflicts.filter((item) => item.takeoverSafe && item.record.id)) {
      try {
        await client.deleteDnsRecord(zone.id, conflict.record.id!);
        live = live.filter((record) => record.id !== conflict.record.id);
        removed.push(
          `${conflict.record.type} ${conflict.record.name} → ` +
            `${conflict.record.priority != null ? `${conflict.record.priority} ` : ""}` +
            `${conflict.record.content}`,
        );
      } catch (err) {
        // Silinemedi: yazmaya calismak ham Cloudflare hatasi uretir. Sebebi
        // oldugu gibi soyleyip bu kaydi atliyoruz.
        failed.push({
          name: `${row.record_type} ${row.name}`,
          error: `${conflict.message} Eski kayıt kaldırılamadı: ${(err as Error).message}`,
        });
        takeoverFailed = true;
        break;
      }
    }
    if (takeoverFailed) continue;

    // Kayit zaten yerinde: yazacak bir sey yok. Kalan (kaldirilmayan) web
    // cakismalari yine de bildirilir.
    if (exists) {
      for (const leftover of conflicts) {
        if (live.some((record) => record.id === leftover.record.id)) warnings.push(leftover.message);
      }
      continue;
    }

    // Devralmadan sonra hala engel varsa (web kaydi) — yazmayi denemeyiz.
    const blocker = conflicts.find(
      (item) => item.blocking && live.some((record) => record.id === item.record.id),
    );
    if (blocker) {
      failed.push({ name: `${row.record_type} ${row.name}`, error: blocker.message });
      continue;
    }

    try {
      const result = await client.createDnsRecord(zone.id, toCloudflarePayload(row));
      await pg.query("UPDATE dns_records SET cloudflare_id = $1, synced_at = NOW() WHERE id = $2", [
        result.id,
        row.id,
      ]);
      created.push(row.name);
      // Kaldirilmayan (web) cakismalar yazma sonrasi uyari olarak bildirilir.
      for (const leftover of conflicts) {
        if (live.some((record) => record.id === leftover.record.id)) warnings.push(leftover.message);
      }
    } catch (err) {
      failed.push({ name: `${row.record_type} ${row.name}`, error: (err as Error).message });
    }
  }

  // Panelin planlamadigi ama postayi sessizce bozan kalintilar.
  warnings.push(...autoconfigLeftovers(live, domainName));

  return { created: created.length, failed, removed, warnings };
}
