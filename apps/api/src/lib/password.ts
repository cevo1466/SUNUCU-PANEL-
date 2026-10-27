// Parola hash: @node-rs/argon2 (musl uyumlu prebuilt binary, derleyici gerektirmez).
// AGENTS.md § Kilitli Kararlar/Data: "yalnızca bcrypt veya argon2" şartını karşılar.
import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(
  plain: string,
  storedHash: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
