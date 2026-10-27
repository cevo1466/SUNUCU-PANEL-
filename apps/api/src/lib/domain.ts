import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import type { Pool } from "pg";
import { env, PROJECT_ROOT } from "../env.js";
import { makeSafeRoot, resolveWithinRoot, PathTraversalError } from "./safe-path.js";

// Modül 4 (files.ts/backups.ts) domain'in KENDİ dizinini ("<domain>/") kök
// alır; bu yüzden vhosts kökü burada tek yerde hesaplanıp paylaşılıyor.
export const VHOSTS_ROOT = makeSafeRoot(env.VHOSTS_ROOT);

export const GENERATED_DIR = path.join(PROJECT_ROOT, "ops", "generated");

// RFC 1952/1123 hostname: 1-63 karakterlik etiketler, nokta ile ayrılmış,
// etiket başı/sonu tire olamaz, toplam uzunluk <=253. Bu desen zaten
// ".." veya "/" içeren hiçbir girdiyle eşleşmez — path-traversal karakterleri
// geçerli bir hostname karakteri değildir.
const HOSTNAME_RE =
  /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

export class InvalidDomainError extends Error {}

export function assertValidDomainName(domainName: string): void {
  if (typeof domainName !== "string" || domainName.length === 0 || domainName.length > 253) {
    throw new InvalidDomainError("Geçersiz domain adı.");
  }
  // Savunma derinliği: regex zaten bunları reddeder ama açıkça de kontrol et.
  if (domainName.includes("..") || domainName.includes("/") || domainName.includes("\\")) {
    throw new InvalidDomainError("Domain adı '..', '/' veya '\\\\' içeremez.");
  }
  if (!HOSTNAME_RE.test(domainName)) {
    throw new InvalidDomainError("Domain adı geçerli bir hostname formatında olmalı (örn. example.com).");
  }
}

export function domainRootPath(domainName: string): string {
  assertValidDomainName(domainName);
  try {
    // Paylaşılan path-traversal savunması (Modül 4 ile aynı yardımcı) —
    // AGENTS.md § Security: "path normalizasyonu sonrası kök dışına çıkan
    // istekler 403 ile reddedilir."
    return resolveWithinRoot(VHOSTS_ROOT, domainName);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new InvalidDomainError(err.message);
    }
    throw err;
  }
}

export function domainDirectoryPath(domainName: string): string {
  return path.join(domainRootPath(domainName), "public");
}

export async function createDomainDirectory(domainName: string): Promise<string> {
  const dir = domainDirectoryPath(domainName);
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
}

export function domainConfPath(domainName: string): string {
  assertValidDomainName(domainName);
  return path.join(GENERATED_DIR, `${domainName}.conf`);
}

export function domainBackupPath(domainName: string): string {
  assertValidDomainName(domainName);
  return path.join(VHOSTS_ROOT.resolved, `${domainName}.tar.gz`);
}

// Gerçek üretim nginx'inin bu domain için config'i zaten devreye almış olup
// olmadığını OKUYARAK (yazmadan) kontrol eder. devuser /etc/nginx/conf.d'yi
// okuyabiliyor ama yazamıyor (bkz. MEMORY.md Oturum 1) — bu yüzden bu her
// zaman gerçek bir kontrol, asla "muhtemelen" değil.
export function isNginxDeployed(domainName: string): boolean {
  assertValidDomainName(domainName);
  const systemConfPath = `/etc/nginx/conf.d/${domainName}.conf`;
  try {
    return fsSync.existsSync(systemConfPath);
  } catch {
    return false;
  }
}

export function isConfigGenerated(domainName: string): boolean {
  return fsSync.existsSync(domainConfPath(domainName));
}

export function directoryExists(directoryPath: string): boolean {
  return fsSync.existsSync(directoryPath);
}

export interface OwnedDomainRow {
  id: number;
  domain_name: string;
  directory_path: string;
}

// domains.ts, files.ts, backups.ts ve diğerlerinin HEPSİ "bu domain gerçekten
// bu kullanıcıya mı ait" kontrolünü aynı şekilde yapar — tek yerde tutulur.
//
// role: "admin" tüm domainlere erişebilir (domain başka bir müşteri hesabına
// devredilmiş olsa bile — bkz. POST /api/domains/:id/customer-account).
// "customer" yalnızca kendi user_id'sine bağlı domain(ler)i görebilir.
export async function getOwnedDomain(
  pg: Pool,
  id: number,
  userId: number,
  role: "admin" | "customer" = "customer",
): Promise<OwnedDomainRow | null> {
  const { rows } =
    role === "admin"
      ? await pg.query(`SELECT id, domain_name, directory_path FROM domains WHERE id = $1`, [id])
      : await pg.query(
          `SELECT id, domain_name, directory_path FROM domains WHERE id = $1 AND user_id = $2`,
          [id, userId],
        );
  return rows[0] ?? null;
}

export function parseIdParam(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}
