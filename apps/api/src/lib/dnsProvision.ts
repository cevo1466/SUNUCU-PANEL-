import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { CloudflareClient, DnsRecordInput } from "./cloudflare.js";
import { CloudflareError } from "./cloudflare.js";
import { findDnsConflicts } from "./dns-conflicts.js";
import { resolveZoneForDomain } from "./dns-sync.js";
import { isZoneDeployed, writeZoneFile, type ZoneRecord } from "./localDns.js";
import { PROJECT_ROOT } from "../env.js";

const execFileAsync = promisify(execFile);
const DEPLOY_ZONE_SCRIPT = path.join(PROJECT_ROOT, "ops", "scripts", "deploy-zone.sh");

export interface PlannedDnsRecord {
  record_type: "A" | "CNAME" | "TXT" | "MX" | "SRV";
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  weight?: number;
  port?: number;
  /**
   * Cloudflare proxy (turuncu bulut). Sadece A/CNAME için anlamlıdır —
   * Cloudflare MX/TXT/SRV'de bu alanı zaten yok sayar. Burada üretilen HİÇBİR
   * kayıt proxied:true İLE ÜRETİLMEZ: mail.* ve MX hedefleri proxy ARKASINDA
   * asla olamaz (SMTP/IMAP/POP3 Cloudflare proxy'sinden geçmez, e-posta
   * tamamen kırılır) — kullanıcı kuralı. @ / www için de güvenli varsayılan
   * (false) korunur; admin isterse panelden PUT ile proxied:true'ya çevirir
   * (bkz. routes/dns.ts, dns_records.proxied kolonu).
   */
  proxied?: boolean;
}

export interface BuildDefaultDnsRecordsResult {
  records: PlannedDnsRecord[];
  warnings: string[];
}

const TTL = 3600;

/**
 * Yeni domain için "olması gereken" öneri DNS kayıtlarını hesaplar. SAF
 * fonksiyon — hiçbir I/O yapmaz, hiçbir yere yazmaz. Çağıran taraf
 * (routes/domains.ts) sonucu dns_records tablosuna cloudflare_id=NULL ile
 * ekler; gerçek Cloudflare'e gönderim ayrı bir admin aksiyonudur.
 *
 * serverIp verilmezse (env.SERVER_PUBLIC_IP tanımsız), sunucuya işaret eden
 * A kayıtları (@ / www / mail) ATLANIR ve warnings'e eklenir — sahte bir
 * "hazır" izlenimi vermek yerine `renderZoneFile`'daki uyarı deseniyle
 * tutarlı şekilde eksik bırakılır. MX/SPF/DKIM/DMARC/SRV kayıtları serverIp
 * olmadan da anlamlıdır (hedef hostname'i beyan ederler), bu yüzden yine de
 * üretilir.
 */
export function buildDefaultDnsRecords(
  domainName: string,
  opts: { serverIp: string | null; dkimTxtValue: string },
): BuildDefaultDnsRecordsResult {
  const { serverIp, dkimTxtValue } = opts;
  const warnings: string[] = [];
  const mailHost = `mail.${domainName}`;
  const records: PlannedDnsRecord[] = [];

  if (serverIp) {
    // @ / www proxied:false VARSAYILAN (admin panelden proxied:true'ya
    // çevirebilir). mail/webmail HER ZAMAN false — bkz. PlannedDnsRecord.proxied.
    records.push({ record_type: "A", name: domainName, content: serverIp, ttl: TTL, proxied: false });
    records.push({ record_type: "A", name: `www.${domainName}`, content: serverIp, ttl: TTL, proxied: false });
    records.push({ record_type: "A", name: mailHost, content: serverIp, ttl: TTL, proxied: false });
    records.push({ record_type: "A", name: `webmail.${domainName}`, content: serverIp, ttl: TTL, proxied: false });
  } else {
    warnings.push(
      "SERVER_PUBLIC_IP tanımlı değil — @, www, mail ve webmail A kayıtları atlandı. Sunucu IP'sini ayarlayıp kayıtları elle ekleyin.",
    );
  }

  records.push({ record_type: "MX", name: domainName, content: mailHost, ttl: TTL, priority: 10 });
  // SPF: sunucu IP'si biliniyorsa ip4: ile ACIKCA belirtilir (a/mx zaten
  // ayni anlama gelir ama ip4 gecikmis DNS yayilimina karsi daha saglam bir
  // ikinci referans saglar); IP yoksa a/mx'e dayanan kisaltilmis hal.
  records.push({
    record_type: "TXT",
    name: domainName,
    content: serverIp ? `v=spf1 a mx ip4:${serverIp} ~all` : "v=spf1 a mx ~all",
    ttl: TTL,
  });
  records.push({
    record_type: "TXT",
    name: `default._domainkey.${domainName}`,
    content: dkimTxtValue,
    ttl: TTL,
  });
  // DMARC: p=none (izleme modu, admin hazir oldugunda quarantine/reject'e
  // yukseltir) + sp=none (alt alan adlari icin ayni politika) + aspf=r
  // (gevsek SPF hizalamasi — kullanici kurali).
  records.push({
    record_type: "TXT",
    name: `_dmarc.${domainName}`,
    content: "v=DMARC1; p=none; sp=none; aspf=r;",
    ttl: TTL,
  });

  // RFC 6186 — mail istemcilerinin (Outlook, Thunderbird, ...) IMAP/POP/
  // gönderim ayarlarını otomatik bulması için.
  const srvServices: Array<{ service: string; port: number }> = [
    { service: "_imap._tcp", port: 143 },
    { service: "_imaps._tcp", port: 993 },
    { service: "_pop3._tcp", port: 110 },
    { service: "_pop3s._tcp", port: 995 },
    { service: "_submission._tcp", port: 587 },
  ];
  for (const { service, port } of srvServices) {
    records.push({
      record_type: "SRV",
      name: `${service}.${domainName}`,
      content: mailHost,
      ttl: TTL,
      priority: 0,
      weight: 1,
      port,
    });
  }

  return { records, warnings };
}

/**
 * Bir dns_records satırını gerçek Cloudflare API sözleşmesine çevirir.
 * MX: üst düzey "priority" alanı. SRV: "content" yok, "data" objesi var —
 * Cloudflare, name'i "_service._proto.name" olarak, service/proto'yu da
 * ayrıca "data" içinde bekler (uyumluluk için ikisi de dolduruluyor).
 */
export function toCloudflarePayload(record: {
  record_type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number | null;
  weight?: number | null;
  port?: number | null;
}): DnsRecordInput {
  if (record.record_type === "SRV") {
    const match = /^(_[^.]+)\.(_[^.]+)\.(.+)$/.exec(record.name);
    const [, service, proto, name] = match ?? [null, "_unknown", "_tcp", record.name];
    return {
      type: "SRV",
      name: record.name,
      ttl: record.ttl,
      data: {
        service,
        proto,
        name,
        priority: record.priority ?? 0,
        weight: record.weight ?? 0,
        port: record.port ?? 0,
        target: record.content,
      },
    };
  }
  if (record.record_type === "MX") {
    return {
      type: "MX",
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority ?? 0,
    };
  }
  return {
    type: record.record_type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied ?? false,
  };
}

interface DbDnsRecordRow {
  id: number;
  record_type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority: number | null;
  weight: number | null;
  port: number | null;
}

export interface PushToCloudflareResult {
  status: "not_configured" | "zone_not_found" | "ok";
  zone?: { id: string; name: string };
  results: Array<{
    id: number;
    ok: boolean;
    cloudflareId?: string;
    error?: string;
    /** Yazildi ama bolgede dikkat isteyen eski bir kayit kaldi. */
    warning?: string;
    /** Devralinirken kaldirilan eski kayitlar (tam degerleriyle). */
    removed?: string[];
  }>;
}

/**
 * cloudflare_id IS NULL olan (henüz gönderilmemiş) tüm kayıtları gerçek
 * Cloudflare hesabına yazar. routes/dns.ts'in tekil push-to-cloudflare
 * route'u VE routes/domains.ts'in "domain oluştururken otomatik gönder"
 * seçeneği bunu paylaşır — davranış tek yerde tanımlı.
 *
 * DEVRALINAN BOLGE (2026-09-05): baska saglayicidan gelen bir bolgede eski
 * kayitlar durur. Onceden her kayit korlemesine POST ediliyordu; sonuc ya ham
 * Ingilizce Cloudflare hatasi ya da — daha kotusu — sessizce yanlis DNS
 * oluyordu (ikinci SPF, ayni oncelikte iki MX). Karar artik tek yerde:
 * lib/dns-conflicts.ts. Posta kayitlarinin onunu tikayan eskiler devralinir,
 * WEB kayitlarina (apeks A, www) dokunulmaz — orada calisan bir site olabilir.
 */
export async function pushDomainDnsToCloudflare(
  pg: Pool | PoolClient,
  client: CloudflareClient,
  domainId: number,
  domainName: string,
): Promise<PushToCloudflareResult> {
  const { configured, zone } = await resolveZoneForDomain(client, domainName);
  if (!configured) return { status: "not_configured", results: [] };
  if (!zone) return { status: "zone_not_found", results: [] };

  const { rows } = await pg.query<DbDnsRecordRow>(
    `SELECT id, record_type, name, content, ttl, priority, weight, port, proxied
       FROM dns_records WHERE domain_id = $1 AND cloudflare_id IS NULL ORDER BY id`,
    [domainId],
  );

  // Bolgenin GERCEK durumu bir kez okunur; her kayitta yeniden sormak hem
  // yavas hem de yaris kosulu yaratir.
  let live = await client.listDnsRecords(zone.id);

  const results: PushToCloudflareResult["results"] = [];
  for (const record of rows) {
    const { exists, conflicts } = findDnsConflicts(record, live, domainName);

    // Devralinabilir engelleri kaldir (yalnizca posta kayitlari).
    //
    // `exists` OLSA BILE calisir: panelin MX'i yerindeyken eski saglayicinin
    // MX'i de duruyorsa gelen postanin yarisi oraya gider.
    const removed: string[] = [];
    let takeoverError: string | null = null;
    for (const conflict of conflicts.filter((item) => item.takeoverSafe && item.record.id)) {
      try {
        await client.deleteDnsRecord(zone.id, conflict.record.id!);
        live = live.filter((item) => item.id !== conflict.record.id);
        removed.push(`${conflict.record.type} ${conflict.record.name} → ${conflict.record.content}`);
      } catch (err) {
        takeoverError = `${conflict.message} Eski kayıt kaldırılamadı: ${(err as Error).message}`;
        break;
      }
    }
    if (takeoverError) {
      results.push({ id: record.id, ok: false, error: takeoverError, removed });
      continue;
    }

    // Ayni kayit bolgede zaten var: HATA DEGIL. Eskiden buraya POST edilir,
    // Cloudflare "already exists" derdi ve cloudflare_id sonsuza dek NULL
    // kalirdi — panel her denemede ayni kaydi yeniden gondermeye calisirdi.
    if (exists) {
      const match = live.find(
        (item) =>
          item.type === record.record_type &&
          item.name.toLowerCase() === record.name.toLowerCase(),
      );
      if (match?.id) {
        await pg.query(`UPDATE dns_records SET cloudflare_id = $1, synced_at = NOW() WHERE id = $2`, [
          match.id,
          record.id,
        ]);
      }
      const leftover = conflicts.find((item) =>
        live.some((current) => current.id === item.record.id),
      );
      results.push({
        id: record.id,
        ok: true,
        cloudflareId: match?.id,
        ...(leftover ? { warning: leftover.message } : {}),
        ...(removed.length > 0 ? { removed } : {}),
      });
      continue;
    }

    // Kalan engel varsa (web kaydi) yazmayi denemeyiz: ham API hatasi yerine
    // ne yapilacagini soyleyen mesaj doner.
    const blocker = conflicts.find(
      (item) => item.blocking && live.some((current) => current.id === item.record.id),
    );
    if (blocker) {
      results.push({ id: record.id, ok: false, error: blocker.message, removed });
      continue;
    }

    try {
      const created = await client.createDnsRecord(zone.id, toCloudflarePayload(record));
      await pg.query(`UPDATE dns_records SET cloudflare_id = $1, synced_at = NOW() WHERE id = $2`, [
        created.id,
        record.id,
      ]);
      live.push(created);
      const leftover = conflicts.find((item) =>
        live.some((current) => current.id === item.record.id),
      );
      results.push({
        id: record.id,
        ok: true,
        cloudflareId: created.id,
        ...(leftover ? { warning: leftover.message } : {}),
        ...(removed.length > 0 ? { removed } : {}),
      });
    } catch (err) {
      const message = err instanceof CloudflareError ? err.message : (err as Error).message;
      results.push({ id: record.id, ok: false, error: message, removed });
    }
  }

  return { status: "ok", zone: { id: zone.id, name: zone.name }, results };
}

/** deploy-vhost.sh ile AYNI desen: dar kapsamlı sudo, script kendi içinde doğrulama+rollback yapar. */
async function applyLocalZone(domainName: string): Promise<{ applied: boolean; error?: string }> {
  try {
    await execFileAsync("sudo", [DEPLOY_ZONE_SCRIPT, domainName], { timeout: 15_000 });
    return { applied: true };
  } catch (err) {
    const message =
      err && typeof err === "object" && "stderr" in err && (err as { stderr?: string }).stderr
        ? (err as { stderr: string }).stderr.trim()
        : (err as Error).message;
    return { applied: false, error: message };
  }
}

export interface ApplyLocalDnsResult {
  ok: true;
  generated_path: string;
  zone_deployed: boolean;
  applied: boolean;
  apply_error?: string;
  warnings: string[];
  content: string;
}

/**
 * Domain'in TÜM yerel dns_records satırlarından bir BIND zone dosyası üretir
 * ve (mümkünse) gerçek BIND9'a uygular. routes/dns.ts'in local-apply route'u
 * VE routes/domains.ts'in "domain oluştururken otomatik uygula" seçeneği
 * bunu paylaşır.
 */
export async function applyDomainLocalDns(
  pg: Pool | PoolClient,
  domainId: number,
  domainName: string,
): Promise<ApplyLocalDnsResult> {
  const { rows } = await pg.query<ZoneRecord>(
    `SELECT record_type, name, content, ttl, priority, weight, port FROM dns_records WHERE domain_id = $1 ORDER BY id`,
    [domainId],
  );
  const { content, warnings, path: zonePath } = await writeZoneFile(domainName, rows);
  const apply = await applyLocalZone(domainName);
  return {
    ok: true,
    generated_path: zonePath,
    zone_deployed: isZoneDeployed(domainName),
    applied: apply.applied,
    apply_error: apply.error,
    warnings,
    content,
  };
}
