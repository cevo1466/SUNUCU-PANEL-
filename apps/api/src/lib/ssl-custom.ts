import { spawn } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "../env.js";

/**
 * ops/scripts/ssl-custom.sh köprüsü (ücretli CA sertifikaları).
 *
 * Özel anahtar ASLA bu katmandan geçerek panele dönmez: `csr` yalnızca CSR
 * metnini, `info` yalnızca açık sertifika alanlarını döndürür. Anahtarı yazan
 * ve okuyan tek taraf root script'tir.
 */
const SCRIPT = path.join(PROJECT_ROOT, "ops", "scripts", "ssl-custom.sh");

/** Certbot'tan kısa ama nginx reload + docker cp dahil. */
const TIMEOUT_MS = 60_000;

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runSslCustom(
  command: "csr" | "install" | "info" | "pending" | "remove",
  domain: string,
  stdin = "",
  extra: string[] = [],
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn("sudo", ["-n", SCRIPT, command, domain, ...extra], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      stderr += `\nHATA: İşlem ${TIMEOUT_MS / 1000} saniyede tamamlanmadı ve durduruldu.`;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      stderr += `\nHATA: ${err.message}`;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

/** Kullanıcıya gösterilecek sebep: script her çıkışta `HATA: ...` yazar. */
export function scriptFailureReason(result: ScriptResult): string {
  const lines = result.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const hata = [...lines].reverse().find((l) => l.startsWith("HATA:"));
  if (hata) return hata.replace(/^HATA:\s*/, "");
  if (lines.length > 0) return lines.slice(-3).join(" ").slice(0, 500);
  return "Sertifika işlemi tamamlanamadı.";
}

export interface CertDetails {
  present: boolean;
  type?: "custom" | "letsencrypt";
  subject?: string;
  issuer?: string;
  serial?: string;
  notBefore?: string | null;
  notAfter?: string | null;
  fingerprint?: string;
  sans: string[];
  keyAlgo?: string;
  keyBits?: number | null;
  chainLength?: number;
  pendingCsr: boolean;
}

/** `anahtar=deger` satırlarını ayrıştırır (bkz. ssl-custom.sh info). */
export function parseInfo(stdout: string): CertDetails {
  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  const pendingCsr = map.get("pending_csr") === "1";
  if (map.get("present") !== "1") return { present: false, sans: [], pendingCsr };
  const sans = (map.get("sans") ?? "")
    .split(",")
    .map((s) => s.replace(/^DNS:/, "").replace(/^IPAddress:/, "").trim())
    .filter(Boolean);
  const bits = Number.parseInt(map.get("key_bits") ?? "", 10);
  const chain = Number.parseInt(map.get("chain_length") ?? "", 10);
  const iso = (v?: string) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return {
    present: true,
    type: map.get("type") === "custom" ? "custom" : "letsencrypt",
    subject: map.get("subject"),
    issuer: map.get("issuer"),
    serial: map.get("serial"),
    notBefore: iso(map.get("not_before")),
    notAfter: iso(map.get("not_after")),
    fingerprint: map.get("fingerprint"),
    sans,
    keyAlgo: map.get("key_algo"),
    keyBits: Number.isNaN(bits) ? null : bits,
    chainLength: Number.isNaN(chain) ? undefined : chain,
    pendingCsr,
  };
}

/** `SSL_RESULT k=v k=v ...` satırından alanları çıkarır. `issuer` boşluk içerebilir → son alan. */
export function parseResult(stdout: string): Record<string, string> | null {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("SSL_RESULT "));
  if (!line) return null;
  const out: Record<string, string> = {};
  const body = line.slice("SSL_RESULT ".length);
  const issuerAt = body.indexOf(" issuer=");
  const head = issuerAt >= 0 ? body.slice(0, issuerAt) : body;
  if (issuerAt >= 0) out.issuer = body.slice(issuerAt + " issuer=".length);
  for (const pair of head.split(" ")) {
    const idx = pair.indexOf("=");
    if (idx > 0) out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}
