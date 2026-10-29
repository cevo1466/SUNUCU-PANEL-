import type { FastifyPluginAsync } from "fastify";
import { hitRateLimit } from "../lib/rate-limit.js";
import { registerInputSchema, loginInputSchema } from "@studio-panel/shared";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { createSession, destroySession, SESSION_COOKIE_NAME } from "../lib/session.js";
import { env } from "../env.js";
import { invalidInput } from "../lib/validation.js";

const COOKIE_OPTS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  // Token zaten kriptografik olarak rastgele (32 byte) ve DB'de hash'lenerek
  // doğrulanıyor; ayrıca imzalamaya gerek yok (imzalı olsaydı okuma tarafında
  // unsignCookie kullanmak gerekirdi — basitlik için opaque token tercih edildi).
};

/**
 * Oturum çerezinin `secure` bayrağı İSTEĞİN ŞEMASINA göre belirlenir.
 *
 * NEDEN SABİT DEĞİL: panel 2026-09-03'e kadar yalnızca HTTP'deydi ve çerez
 * korumasız taşınıyordu. Artık `panel.ornek.test` HTTPS'te — ama IP
 * üzerinden HTTP erişimi de bilerek duruyor (yönetici kendini dışarıda
 * bırakmasın diye). Çerezi koşulsuz `secure` yapmak o yoldan girişi
 * sessizce imkânsız kılardı: tarayıcı çerezi hiç saklamaz, kullanıcı
 * "giriş çalışmıyor" der ve sebebi hiçbir yerde görünmez.
 *
 * `X-Forwarded-Proto`'yu nginx yazıyor (bkz. studio-panel-ssl.conf).
 * Başlık taklit edilse bile yön güvenli: en kötü ihtimalle HTTP
 * istemcisine `secure` çerez verilir, tarayıcı onu saklamaz ve giriş
 * BAŞARISIZ olur — açık bırakmaz, kapatır.
 */
export function cookieOptsFor(request: { headers: Record<string, unknown> }) {
  const proto = request.headers["x-forwarded-proto"];
  const isHttps = typeof proto === "string" && proto.split(",")[0].trim() === "https";
  return { ...COOKIE_OPTS, secure: isHttps };
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/auth/register", async (request, reply) => {
    if (!env.ALLOW_PUBLIC_REGISTRATION) {
      reply.code(404);
      return { error: "Kayıt kapalı. Bu panel tek yönetici için ayrılmıştır." };
    }
    const parsed = registerInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }
    const { username, email, password } = parsed.data;

    const existing = await fastify.pg.query(
      "SELECT id FROM users WHERE email = $1 OR username = $2",
      [email, username],
    );
    if (existing.rows.length > 0) {
      reply.code(409);
      return { error: "Bu e-posta veya kullanıcı adı zaten kayıtlı." };
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await fastify.pg.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id, username, email, role, created_at",
      [username, email, passwordHash],
    );
    const user = rows[0];

    const { token, expiresAt } = await createSession(fastify.pg, user.id);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      ...cookieOptsFor(request),
      expires: expiresAt,
    });

    reply.code(201);
    return { user };
  });

  fastify.post("/api/auth/login", async (request, reply) => {
    const parsed = loginInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }
    const { email, password } = parsed.data;

    if (hitRateLimit(`login:ip:${request.ip}`, 20, 60_000) || hitRateLimit(`login:email:${email}`, 8, 60_000)) {
      reply.code(429);
      return { error: "Çok fazla deneme. Bir dakika sonra tekrar deneyin." };
    }

    // Panel iki tür girişe açık: tek yönetici hesabı (OWNER_EMAIL, role=admin)
    // ve domain başına tanımlanmış müşteri hesapları (role=customer). Başka
    // hiçbir e-posta ile giriş yapılamaz — admin dışı bir hesap ancak
    // POST /api/domains/:id/customer-account ile admin tarafından açılabilir.
    if (email !== env.OWNER_EMAIL) {
      const { rows: customerRows } = await fastify.pg.query(
        "SELECT id, username, email, password_hash, role FROM users WHERE email = $1 AND role = 'customer'",
        [email],
      );
      const customer = customerRows[0];
      if (!customer || !(await verifyPassword(password, customer.password_hash))) {
        reply.code(401);
        return { error: "E-posta veya parola hatalı." };
      }
      const { token, expiresAt } = await createSession(fastify.pg, customer.id);
      reply.setCookie(SESSION_COOKIE_NAME, token, { ...cookieOptsFor(request), expires: expiresAt });
      return { user: { id: customer.id, username: customer.username, email: customer.email, role: customer.role } };
    }

    const { rows } = await fastify.pg.query(
      "SELECT id, username, email, password_hash, role FROM users WHERE email = $1",
      [email],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      reply.code(401);
      return { error: "E-posta veya parola hatalı." };
    }

    const { token, expiresAt } = await createSession(fastify.pg, user.id);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      ...cookieOptsFor(request),
      expires: expiresAt,
    });

    return { user: { id: user.id, username: user.username, email: user.email, role: user.role } };
  });

  fastify.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await destroySession(fastify.pg, token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  fastify.get("/api/auth/me", async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401);
      return { error: "Yetkisiz" };
    }
    return { user: request.currentUser };
  });
};

export default authRoutes;
