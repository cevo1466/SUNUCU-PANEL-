import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { assertValidDomainName, GENERATED_DIR } from "./domain.js";
import { splitTxtValue } from "./dkim.js";
import { env } from "../env.js";

export interface ZoneRecord {
  record_type: "A" | "CNAME" | "TXT" | "MX" | "SRV";
  name: string;
  content: string;
  ttl: number;
  priority?: number | null;
  weight?: number | null;
  port?: number | null;
}

const ZONES_DIR = path.join(GENERATED_DIR, "zones");

export function zoneFilePath(domainName: string): string {
  assertValidDomainName(domainName);
  return path.join(ZONES_DIR, `${domainName}.zone`);
}

/** deploy-zone.sh'in gerçek DNS sunucusuna uyguladığı hedef — deployed olup
 * olmadığını dosya varlığından anlıyoruz, tıpkı nginx conf.d kontrolü gibi. */
export function deployedZonePath(domainName: string): string {
  assertValidDomainName(domainName);
  return path.join("/etc/bind/zones", `${domainName}.zone`);
}

export function isZoneGenerated(domainName: string): boolean {
  return fsSync.existsSync(zoneFilePath(domainName));
}

export function isZoneDeployed(domainName: string): boolean {
  return fsSync.existsSync(deployedZonePath(domainName));
}

function zoneName(recordName: string, domain: string): string {
  const trimmed = recordName.trim();
  if (trimmed === "" || trimmed === "@" || trimmed === domain) return "@";
  return trimmed.endsWith(`.${domain}`) ? trimmed.slice(0, -(domain.length + 1)) : trimmed;
}

/** Hedefin sonuna FQDN noktası ekler — CNAME/MX/NS gibi isim taşıyan
 * kayıtlarda nokta unutmak klasik bir BIND hatasıdır (döngüsel genişleme). */
function fqdn(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

/**
 * BIND uyumlu bir zone dosyası üretir. Sunucunun kendi (Cloudflare dışı)
 * otoriter DNS'i için — bkz. madde 5 kararı. NS_PRIMARY/SECONDARY
 * tanımlı değilse placeholder değerlerle üretir ve bunu çağıran tarafa
 * `warnings` ile bildirir; sahte bir "hazır" izlenimi vermez.
 */
export function renderZoneFile(
  domainName: string,
  records: ZoneRecord[],
): { content: string; warnings: string[] } {
  assertValidDomainName(domainName);
  const warnings: string[] = [];

  const primaryNs = env.DNS_PRIMARY_NS ?? `ns1.${domainName}`;
  if (!env.DNS_PRIMARY_NS) warnings.push("DNS_PRIMARY_NS tanımlı değil — placeholder kullanıldı.");
  const secondaryNs = env.DNS_SECONDARY_NS;
  const hostmaster = (env.DNS_HOSTMASTER_EMAIL ?? `hostmaster@${domainName}`).replace("@", ".");
  // Standart DNS zone seri kuralı: YYYYMMDDNN (10 hane, artan). Bu fonksiyon
  // SAF ve durumsuz olduğu için gerçek bir "günün kaçıncı revizyonu" sayacı
  // tutulamıyor — YYYYMMDDHH (saat çözünürlüğü) kullanılır: aynı 10 hane
  // uzunluğunda, okunur ve gün içinde kendiliğinden artar. Tek sınırı: aynı
  // saat içinde ikinci bir render birebir aynı seri üretir (BIND bunu
  // "değişiklik yok" sayar, bir sonraki saate kadar yayılmaz) — tek yetkili
  // kullanım için kabul edilebilir bir ödünleşim.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const serial = Number(
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`,
  );

  const lines: string[] = [];
  lines.push("$TTL 3600");
  lines.push(
    `@   IN  SOA ${fqdn(primaryNs)} ${fqdn(hostmaster)} (`,
    `        ${serial} ; serial`,
    "        3600       ; refresh",
    "        900        ; retry",
    "        604800     ; expire",
    "        3600 )     ; minimum",
    "",
  );
  lines.push(`    IN  NS  ${fqdn(primaryNs)}`);
  if (secondaryNs) lines.push(`    IN  NS  ${fqdn(secondaryNs)}`);
  lines.push("");

  for (const record of records) {
    const name = zoneName(record.name, domainName);
    let value: string;
    if (record.record_type === "MX") {
      value = `${record.priority ?? 0} ${fqdn(record.content)}`;
    } else if (record.record_type === "SRV") {
      // BIND SRV syntax: priority weight port target.
      value = `${record.priority ?? 0} ${record.weight ?? 0} ${record.port ?? 0} ${fqdn(record.content)}`;
    } else if (record.record_type === "CNAME") {
      value = fqdn(record.content);
    } else if (record.record_type === "TXT") {
      // DKIM public key gibi 255 bayttan uzun TXT değerleri BIND'de birden
      // fazla quoted-string olarak birleştirilir: "parça1" "parça2".
      value = splitTxtValue(record.content)
        .map((chunk) => `"${chunk.replace(/"/g, '\\"')}"`)
        .join(" ");
    } else {
      value = record.content;
    }
    lines.push(`${name}\t${record.ttl}\tIN\t${record.record_type}\t${value}`);
  }

  return { content: lines.join("\n") + "\n", warnings };
}

export async function writeZoneFile(domainName: string, records: ZoneRecord[]) {
  const { content, warnings } = renderZoneFile(domainName, records);
  await fs.mkdir(ZONES_DIR, { recursive: true });
  const outPath = zoneFilePath(domainName);
  await fs.writeFile(outPath, content, "utf8");
  return { path: outPath, content, warnings };
}
