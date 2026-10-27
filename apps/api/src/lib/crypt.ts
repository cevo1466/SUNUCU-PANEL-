import crypto from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Sanal kullanıcı servislerinin (pure-ftpd, Dovecot) beklediği parola
 * üretimi ve hash'i.
 *
 * ORTAK YERE ALINDI: `sha512Crypt` parolayı `openssl passwd`'e argüman
 * olarak DEĞİL stdin ile veriyor — argüman olsaydı süreç listesinde
 * (`ps aux`) düz metin görünürdü. Bu güvenlik inceliği kopyalanmamalı;
 * kopyalansaydı ileride birinde düzeltilip diğerinde unutulacak bir sızıntı
 * yolu kalırdı. FTP ve e-posta modülleri ikisini de buradan alır.
 *
 * NOT (AGENTS.md § Data): Panel KULLANICI parolaları argon2'dir
 * (lib/password.ts). Buradaki SHA-512 crypt yalnızca pure-ftpd ve Dovecot'un
 * doğrulayabildiği şema olduğu için sanal servis hesaplarında kullanılır.
 */

export class CryptError extends Error {}

/** Karışabilen karakterler (0/O, 1/l/I) bilerek dışarıda — parola elle yazılacak. */
export function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Parolayı SHA-512 crypt (`$6$…`) biçimine çevirir. */
export async function sha512Crypt(password: string): Promise<string> {
  const salt = crypto.randomBytes(12).toString("base64").replace(/[+/=]/g, "").slice(0, 16);
  const hash = await new Promise<string>((resolve, reject) => {
    const child = spawn("openssl", ["passwd", "-6", "-salt", salt, "-stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new CryptError(stderr.trim() || `openssl ${code}`));
    });
    child.stdin.end(`${password}\n`);
  });
  if (!hash.startsWith("$6$")) {
    throw new CryptError("openssl beklenen $6$ biçiminde bir hash döndürmedi.");
  }
  return hash;
}
