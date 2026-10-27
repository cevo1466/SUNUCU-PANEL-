import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getOwnedDomain, parseIdParam } from "../lib/domain.js";
import { MAX_IMPORT_BYTES, importSqlDump } from "../lib/db-import.js";
import { env } from "../env.js";
import { invalidInput } from "../lib/validation.js";
import {
  DatabaseError,
  createDatabase,
  dropDatabase,
  engineStatuses,
  resetDatabasePassword,
  suggestDbName,
  type DbEngine,
  type PanelDatabaseRow,
} from "../lib/databases.js";

const createSchema = z.object({
  engine: z.enum(["postgres", "mysql"]),
  dbName: z.string().trim(),
  dbUser: z.string().trim(),
  password: z.string().trim().optional(),
});

const passwordSchema = z.object({ password: z.string().trim().optional() });

const SELECT_COLUMNS =
  "id, domain_id, engine, db_name, db_user, created_at";

function publicRow(row: PanelDatabaseRow) {
  // Parola zaten hiçbir yerde saklanmıyor; satırda gizlenecek bir alan yok.
  return row;
}

const databasesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  /** Motorların gerçek durumu — kurulu mu, yanıt veriyor mu. */
  fastify.get("/api/databases/engines", async () => {
    return {
      engines: await engineStatuses(fastify.pg),
      // Kurulu değilse null — panel sahte bir link göstermez (bkz.
      // ops/scripts/install-adminer.sh).
      adminerUrl: env.ADMINER_URL ?? null,
    };
  });

  fastify.get("/api/domains/:id/databases", async (request, reply) => {
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

    const { rows } = await fastify.pg.query<PanelDatabaseRow>(
      `SELECT ${SELECT_COLUMNS} FROM panel_databases WHERE domain_id = $1 ORDER BY engine, db_name`,
      [id],
    );

    return {
      databases: rows.map(publicRow),
      // Kullanıcı adı uydurmak zorunda kalmasın: domain adından türetilmiş
      // bir öneri veriyoruz. Çakışma varsa istemci sonuna sayı ekler.
      suggestion: suggestDbName(domain.domain_name),
      engines: await engineStatuses(fastify.pg),
      adminerUrl: env.ADMINER_URL ?? null,
    };
  });

  fastify.post("/api/domains/:id/databases", async (request, reply) => {
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

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }

    try {
      const created = await createDatabase(fastify.pg, {
        domainId: id,
        engine: parsed.data.engine as DbEngine,
        dbName: parsed.data.dbName,
        dbUser: parsed.data.dbUser,
        password: parsed.data.password || undefined,
      });
      reply.code(201);
      return {
        database: publicRow(created.row),
        // Parola YALNIZCA burada, bir kez. DB'ye yazılmıyor, loglanmıyor.
        password: created.password,
        connection: created.connection,
      };
    } catch (err) {
      if (err instanceof DatabaseError) {
        reply.code(err.status);
        return { error: err.message };
      }
      throw err;
    }
  });

  fastify.post("/api/domains/:id/databases/:dbId/password", async (request, reply) => {
    const found = await lookup(request, reply);
    if (!found) return reply;

    const body = passwordSchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.code(400);
      return invalidInput(body.error.issues);
    }

    try {
      const result = await resetDatabasePassword(fastify.pg, found, body.data.password || undefined);
      return { password: result.password, connection: result.connection };
    } catch (err) {
      if (err instanceof DatabaseError) {
        reply.code(err.status);
        return { error: err.message };
      }
      throw err;
    }
  });

  /**
   * Disaridan SQL dokumu yukler.
   *
   * MEVCUT bir veritabaninin ICINE yukler, yeni veritabani ACMAZ — dokumun
   * `CREATE DATABASE` satirlari panelin kayitlarini atlatarak sunucuda
   * panelin bilmedigi veritabanlari yaratabilirdi (bkz. lib/db-import.ts).
   *
   * Dosya once diske yazilir, sonra istemciye verilir: mysql/psql'e stdin
   * uzerinden dokum vermek execFile ile mumkun degil (`input` secenegi yok)
   * ve daha once tam olarak bu yuzden surec girdi beklerken asili kalmisti.
   */
  fastify.post("/api/domains/:id/databases/:dbId/import", async (request, reply) => {
    const found = await lookup(request, reply);
    if (!found) return reply;

    if (!request.isMultipart()) {
      reply.code(400);
      return { error: "Yükleme isteği multipart/form-data olmalı." };
    }

    const uploaded = await request.file({ limits: { fileSize: MAX_IMPORT_BYTES } });
    if (!uploaded) {
      reply.code(400);
      return { error: "Dosya bulunamadı." };
    }

    const work = await fs.mkdtemp(path.join(os.tmpdir(), "studio-db-upload-"));
    const stored = path.join(work, "yuklenen.dump");
    try {
      await pipeline(uploaded.file, fsSync.createWriteStream(stored));
      // @fastify/multipart siniri asinca akisi KESER ve bayragi kaldirir;
      // kontrol edilmezse YARIM bir dokum yuklenir ve "basarili" gorunur.
      if (uploaded.file.truncated) {
        reply.code(413);
        return {
          error: `Dosya ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB sınırını aşıyor.`,
        };
      }

      const result = await importSqlDump(found, stored);
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof DatabaseError) {
        reply.code(err.status);
        return { error: err.message };
      }
      throw err;
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });

  fastify.delete("/api/domains/:id/databases/:dbId", async (request, reply) => {
    const found = await lookup(request, reply);
    if (!found) return reply;

    try {
      await dropDatabase(fastify.pg, found);
      return { ok: true };
    } catch (err) {
      if (err instanceof DatabaseError) {
        reply.code(err.status);
        return { error: err.message };
      }
      throw err;
    }
  });

  /**
   * Domain sahipliği + veritabanı kaydı doğrulaması. Üç uç de aynı kontrolü
   * yapıyordu; sahiplik kontrolünün bir kopyasının unutulması sessiz bir
   * yetki açığı olurdu.
   *
   * @returns Satır, ya da bulunamazsa null (yanıt kodu zaten ayarlanmış olur).
   */
  async function lookup(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PanelDatabaseRow | null> {
    const params = request.params as { id: string; dbId: string };
    const id = parseIdParam(params.id);
    const dbId = parseIdParam(params.dbId);
    if (id === null || dbId === null) {
      reply.code(400).send({ error: "Geçersiz id." });
      return null;
    }

    const domain = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!domain) {
      reply.code(404).send({ error: "Domain bulunamadı." });
      return null;
    }

    const { rows } = await fastify.pg.query<PanelDatabaseRow>(
      `SELECT ${SELECT_COLUMNS} FROM panel_databases WHERE id = $1 AND domain_id = $2`,
      [dbId, id],
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: "Veritabanı bulunamadı." });
      return null;
    }
    return rows[0];
  }
};

export default databasesRoutes;
