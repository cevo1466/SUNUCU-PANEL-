import { invalidInput } from "../lib/validation.js";
import { passwordField } from "@studio-panel/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { getOwnedDomain, parseIdParam } from "../lib/domain.js";
import {
  FtpError,
  applyPureFtpdReload,
  assertValidUsername,
  ftpHomeDir,
  generatePassword,
  hashPassword,
  pureFtpdStatus,
  suggestUsername,
  writePureFtpdPasswd,
  type FtpAccountRow,
} from "../lib/ftp.js";

const createSchema = z.object({
  username: z.string().trim(),
  password: passwordField.optional(),
  quotaMb: z.number().int().min(10).max(1_048_576).nullable().optional(),
});

const updateSchema = z
  .object({
    password: passwordField.optional(),
    quotaMb: z.number().int().min(10).max(1_048_576).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

function publicAccount(row: FtpAccountRow) {
  return {
    id: row.id,
    domain_id: row.domain_id,
    username: row.username,
    home_dir: row.home_dir,
    quota_mb: row.quota_mb,
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

const ftpRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/api/domains/:id/ftp", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }
    const domain = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!domain) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    const { rows } = await fastify.pg.query<FtpAccountRow>(
      `SELECT id, domain_id, username, home_dir, quota_mb, enabled, created_at
         FROM ftp_accounts WHERE domain_id = $1 ORDER BY username`,
      [id],
    );
    return {
      accounts: rows.map(publicAccount),
      suggestedUsername: suggestUsername(domain.domain_name),
      service: await pureFtpdStatus(),
    };
  });

  fastify.post("/api/domains/:id/ftp", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    const parsed = createSchema.safeParse(request.body);
    if (id === null || !parsed.success) {
      reply.code(400);
      // Mesaj SEMADAN uretiliyor; elle yazilmis sayilar kural degisince
      // eskiyor (bkz. routes/mail.ts ayni duzeltme).
      return parsed.success ? { error: "Geçersiz domain id." } : invalidInput(parsed.error.issues);
    }
    const domain = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!domain) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    try {
      assertValidUsername(parsed.data.username);
      const password = parsed.data.password ?? generatePassword();
      const passwordHash = await hashPassword(password);
      const client = await fastify.pg.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<FtpAccountRow>(
          `INSERT INTO ftp_accounts (domain_id, username, password_hash, home_dir, quota_mb)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, domain_id, username, home_dir, quota_mb, enabled, created_at`,
          [id, parsed.data.username, passwordHash, ftpHomeDir(domain.domain_name), parsed.data.quotaMb ?? null],
        );
        await writePureFtpdPasswd(client, env.VHOSTS_ROOT);
        await client.query("COMMIT");
        const reload = await applyPureFtpdReload();
        reply.code(201);
        return { account: publicAccount(rows[0]), password, service: await pureFtpdStatus(), reload };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        reply.code(409);
        return { error: "Bu FTP kullanıcı adı zaten kullanılıyor." };
      }
      if (error instanceof FtpError) {
        reply.code(error.status);
        return { error: error.message };
      }
      throw error;
    }
  });

  fastify.patch("/api/domains/:id/ftp/:accountId", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    const accountId = parseIdParam((request.params as { accountId: string }).accountId);
    const parsed = updateSchema.safeParse(request.body);
    if (id === null || accountId === null || !parsed.success) {
      reply.code(400);
      return { error: "Geçerli hesap, parola, kota veya durum değeri gerekli." };
    }
    if (!(await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role))) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    const passwordHash = parsed.data.password ? await hashPassword(parsed.data.password) : null;
    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<FtpAccountRow>(
        `UPDATE ftp_accounts SET
           password_hash = COALESCE($1, password_hash),
           quota_mb = CASE WHEN $2::boolean THEN $3 ELSE quota_mb END,
           enabled = COALESCE($4, enabled)
         WHERE id = $5 AND domain_id = $6
         RETURNING id, domain_id, username, home_dir, quota_mb, enabled, created_at`,
        [passwordHash, parsed.data.quotaMb !== undefined, parsed.data.quotaMb ?? null, parsed.data.enabled ?? null, accountId, id],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: "FTP hesabı bulunamadı." };
      }
      await writePureFtpdPasswd(client, env.VHOSTS_ROOT);
      await client.query("COMMIT");
      const reload = await applyPureFtpdReload();
      return { account: publicAccount(rows[0]), password: parsed.data.password, reload };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  fastify.delete("/api/domains/:id/ftp/:accountId", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    const accountId = parseIdParam((request.params as { accountId: string }).accountId);
    if (id === null || accountId === null || !(await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role))) {
      reply.code(id === null || accountId === null ? 400 : 404);
      return { error: id === null || accountId === null ? "Geçersiz hesap id." : "Domain bulunamadı." };
    }

    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("DELETE FROM ftp_accounts WHERE id = $1 AND domain_id = $2", [accountId, id]);
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: "FTP hesabı bulunamadı." };
      }
      await writePureFtpdPasswd(client, env.VHOSTS_ROOT);
      await client.query("COMMIT");
      const reload = await applyPureFtpdReload();
      return { ok: true, reload };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
};

export default ftpRoutes;
