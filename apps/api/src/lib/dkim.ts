import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertValidDomainName, GENERATED_DIR } from "./domain.js";

/**
 * DKIM anahtar üretimi ve yönetimi.
 *
 * DÜRÜSTLÜK NOTU (AGENTS.md kuralı, mail.ts'teki aynı desen): bu sunucuda
 * Postfix/OpenDKIM KURULU DEĞİL. Burada üretilen private key, ileride
 * OpenDKIM kurulunca imzalama için kullanılacak gerçek bir RSA anahtarıdır —
 * ama panel hiçbir zaman "e-posta DKIM ile imzalanıyor" iddiasında bulunmaz.
 * Public key parçası DNS TXT kaydına yazılır, private key ASLA API
 * response'unda dönmez.
 */

export const DKIM_SELECTOR = "default";
const DKIM_DIR = path.join(GENERATED_DIR, "dkim");

export function dkimPrivateKeyPath(domainName: string): string {
  assertValidDomainName(domainName);
  return path.join(DKIM_DIR, domainName, `${DKIM_SELECTOR}.private.pem`);
}

/** PEM header/footer ve satır sonlarını temizleyip tek satır base64 döner. */
function pemToSingleLineBase64(pem: string): string {
  return pem
    .split("\n")
    .filter((line) => line && !line.startsWith("-----"))
    .join("");
}

export interface DkimKeyPair {
  selector: string;
  privateKeyPath: string;
  /** `v=DKIM1; k=rsa; p=<base64>` — DNS TXT kaydının ham içeriği. */
  dnsTxtValue: string;
}

/**
 * 2048-bit RSA anahtar çifti üretir, private key'i diske (0600) yazar,
 * DKIM DNS TXT değerini döner. Var olan bir anahtarın üzerine YAZAR —
 * çağıran taraf (domain oluşturma) domain başına bir kez çağırır.
 */
export async function generateDkimKeyPair(domainName: string): Promise<DkimKeyPair> {
  assertValidDomainName(domainName);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const domainDir = path.join(DKIM_DIR, domainName);
  await fs.mkdir(domainDir, { recursive: true, mode: 0o700 });
  const privateKeyPath = dkimPrivateKeyPath(domainName);
  await fs.writeFile(privateKeyPath, privateKey, { mode: 0o600 });

  const publicKeyBase64 = pemToSingleLineBase64(publicKey);
  return {
    selector: DKIM_SELECTOR,
    privateKeyPath,
    dnsTxtValue: `v=DKIM1; k=rsa; p=${publicKeyBase64}`,
  };
}

/**
 * DNS TXT tek-string sınırı (255 bayt) için değeri parçalara böler.
 * BIND zone dosyası çoklu quoted-string'i `"parça1" "parça2"` olarak kabul
 * eder; Cloudflare'e giden `content` alanı ise HAM (parçasız) tutulur —
 * Cloudflare kendi tarafında gerekirse parçalar.
 */
export function splitTxtValue(value: string, chunkSize = 255): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(value.slice(i, i + chunkSize));
  }
  return chunks.length > 0 ? chunks : [""];
}
