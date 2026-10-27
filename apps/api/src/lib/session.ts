import crypto from "node:crypto";
import type { Pool } from "pg";

export const SESSION_COOKIE_NAME = "studio_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  pg: Pool,
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await pg.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, tokenHash, expiresAt],
  );

  return { token, expiresAt };
}

export async function resolveSession(
  pg: Pool,
  token: string,
): Promise<{ id: number; username: string; email: string; role: "admin" | "customer" } | null> {
  const tokenHash = hashToken(token);
  const { rows } = await pg.query(
    `SELECT u.id, u.username, u.email, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function destroySession(pg: Pool, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await pg.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
}
