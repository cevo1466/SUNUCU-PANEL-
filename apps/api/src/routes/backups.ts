import fs from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getOwnedDomain, parseIdParam } from "../lib/domain.js";
import { env } from "../env.js";
import { BackupError, createDomainSnapshot } from "../lib/backup-snapshot.js";
import { localTarget, rotateBackups } from "../lib/backup-storage.js";
import { planRestore, restoreBackup } from "../lib/backup-restore.js";
import { verifyBackup } from "../lib/backup-verify.js";
import { getBackupSchedule, setBackupSchedule } from "../lib/backup-schedule.js";

/**
 * Yedekleme uclari.
 *
 * ESKI SOZLESME KORUNDU: GET/POST/DELETE `/api/domains/:id/backups` ve
 * `/backups/download` ayni yollarda duruyor — arayuz ve varsa disaridan
 * kullanan bir sey kirilmasin. Altlari degisti: artik surumlu, manifest'li
 * ve dogrulanabilir anlik goruntuler uretiliyor.
 */
const backupsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  // Only the server administrator may change the global cron schedule.
  fastify.get("/api/backups/schedule", { preHandler: fastify.requireAdmin }, getBackupSchedule);
  fastify.put("/api/backups/schedule", { preHandler: fastify.requireAdmin }, async (request, reply) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "enabled değeri true veya false olmalı." };
    }
    return setBackupSchedule(body.data.enabled);
  });

  async function requireOwnedDomain(request: {
    params: unknown;
    currentUser: { id: number; role: "admin" | "customer" } | null;
  }) {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) return { error: { status: 400, body: { error: "Geçersiz domain id." } } };
    const owned = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!owned) return { error: { status: 404, body: { error: "Domain bulunamadı." } } };
    return { domain: owned };
  }

  function fail(reply: import("fastify").FastifyReply, err: unknown) {
    if (err instanceof BackupError) {
      reply.code(err.status);
      return { error: err.message };
    }
    throw err;
  }

  /** Dogrulama durumlarini backup_runs'tan okur ve arsiv adina eslestirir. */
  async function verificationMap(domainName: string) {
    const { rows } = await fastify.pg.query<{
      archive_name: string;
      verify_status: string | null;
      verified_at: Date | null;
      verify_error: string | null;
      manifest: unknown;
    }>(
      `SELECT archive_name, verify_status, verified_at, verify_error, manifest
         FROM backup_runs WHERE domain_name = $1 AND kind = 'domain'`,
      [domainName],
    );
    return new Map(rows.map((r) => [r.archive_name, r]));
  }

  // --- Listeleme ---
  fastify.get("/api/domains/:id/backups", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const name = resolved.domain.domain_name;
    const [list, runs] = await Promise.all([localTarget.list(name), verificationMap(name)]);
    return {
      retention: env.BACKUP_KEEP,
      backups: list.map((b) => {
        const run = runs.get(b.name);
        const manifest = (run?.manifest ?? null) as {
          databases?: Array<{ engine: string; name: string }>;
          parts?: Array<{ note: string }>;
          complete?: boolean;
          warnings?: string[];
          file_count?: number;
        } | null;
        return {
          name: b.name,
          size_bytes: b.sizeBytes,
          created_at: new Date(b.createdAtMs).toISOString(),
          file_count: manifest?.file_count ?? null,
          databases: manifest?.databases ?? [],
          complete: manifest?.complete ?? null,
          warnings: manifest?.warnings ?? [],
          // NULL = hic dogrulanmadi. Arayuz bunu YESIL GOSTERMEZ:
          // denenmemis yedek, calisir yedek degildir.
          verify_status: run?.verify_status ?? null,
          verified_at: run?.verified_at ?? null,
          verify_error: run?.verify_error ?? null,
        };
      }),
    };
  });

  // --- Yedek al ---
  fastify.post("/api/domains/:id/backups", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const name = resolved.domain.domain_name;
    const { rows } = await fastify.pg.query<{ id: number }>(
      `INSERT INTO backup_runs (domain_name, kind, archive_name, status) VALUES ($1,'domain','(devam ediyor)','running') RETURNING id`,
      [name],
    );
    const runId = rows[0].id;
    try {
      const { stored, manifest } = await createDomainSnapshot(fastify.pg, name);
      await fastify.pg.query(
        `UPDATE backup_runs SET archive_name=$1, size_bytes=$2, manifest=$3, status='ok', finished_at=NOW() WHERE id=$4`,
        [stored.name, stored.sizeBytes, JSON.stringify(manifest), runId],
      );

      // Rotasyon: dogrulanmis yedekler korunur.
      const verified = await verificationMap(name);
      const verifiedNames = new Set(
        [...verified.entries()].filter(([, r]) => r.verify_status === "ok").map(([k]) => k),
      );
      const removed = await rotateBackups(name, env.BACKUP_KEEP, verifiedNames);

      reply.code(201);
      return {
        name: stored.name,
        size_bytes: stored.sizeBytes,
        created_at: new Date(stored.createdAtMs).toISOString(),
        complete: manifest.complete,
        warnings: manifest.warnings,
        databases: manifest.databases.map((d) => ({ engine: d.engine, name: d.name })),
        rotated_out: removed,
      };
    } catch (err) {
      await fastify.pg.query(
        `UPDATE backup_runs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2`,
        [(err as Error).message, runId],
      );
      return fail(reply, err);
    }
  });

  // --- Indirme ---
  fastify.get("/api/domains/:id/backups/download", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const q = z.object({ name: z.string().max(128).optional() }).safeParse(request.query);
    const name = resolved.domain.domain_name;
    const list = await localTarget.list(name);
    // Ad verilmediyse EN YENI yedek — eski sozlesmenin davranisi.
    const target = q.success && q.data.name ? await localTarget.resolve(name, q.data.name) : list[0];
    if (!target) {
      reply.code(404);
      return { error: "Yedek bulunamadı — önce oluşturun." };
    }
    reply
      .header("Content-Disposition", `attachment; filename="${name}-${target.name}"`)
      .header("Content-Length", String(target.sizeBytes))
      .type("application/gzip");
    return reply.send(fs.createReadStream(target.absolutePath));
  });

  // --- Silme ---
  fastify.delete("/api/domains/:id/backups", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const q = z.object({ name: z.string().max(128) }).safeParse(request.query);
    if (!q.success) {
      reply.code(400);
      return { error: "Silinecek yedeğin adı (name) gerekli." };
    }
    const name = resolved.domain.domain_name;
    const target = await localTarget.resolve(name, q.data.name);
    if (!target) {
      reply.code(404);
      return { error: "Yedek bulunamadı." };
    }
    await localTarget.remove(name, q.data.name);
    return { ok: true };
  });

  // --- Dogrulama (elle tetikleme) ---
  fastify.post("/api/domains/:id/backups/verify", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const body = z.object({ name: z.string().max(128).optional() }).safeParse(request.body ?? {});
    const name = resolved.domain.domain_name;
    const list = await localTarget.list(name);
    const target = body.success && body.data.name ? await localTarget.resolve(name, body.data.name) : list[0];
    if (!target) {
      reply.code(404);
      return { error: "Doğrulanacak yedek yok." };
    }
    const result = await verifyBackup(target);
    await fastify.pg.query(
      `UPDATE backup_runs SET verified_at=NOW(), verify_status=$1, verify_error=$2, verify_detail=$3
        WHERE domain_name=$4 AND archive_name=$5`,
      [result.ok ? "ok" : "failed", result.error ?? null, JSON.stringify(result.detail), name, target.name],
    );
    return { name: target.name, ...result };
  });

  // --- Geri yukleme plani (KURU CALISTIRMA) ---
  fastify.post("/api/domains/:id/backups/restore-plan", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const body = z.object({ name: z.string().min(1).max(128) }).safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "Yedek adı (name) gerekli." };
    }
    try {
      return await planRestore(resolved.domain.domain_name, body.data.name);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Geri yukleme (GERCEK) ---
  //
  // ADMIN-ONLY ve CIFT ONAY: geri yukleme calisan bir siteyi eski haline
  // dondurur. Musteri hesabinin kendi sitesini geri sarmasi meşru olabilir
  // ama sonuclari admin'i ilgilendirir; ilk surumde yalnizca admin yapar.
  fastify.post(
    "/api/domains/:id/backups/restore",
    { preHandler: fastify.requireAdmin },
    async (request, reply) => {
      const resolved = await requireOwnedDomain(request);
      if (resolved.error) {
        reply.code(resolved.error.status);
        return resolved.error.body;
      }
      const body = z
        .object({
          name: z.string().min(1).max(128),
          /** Domain adinin tekrar yazilmasi — silme akisiyla ayni desen. */
          confirm_domain: z.string().min(1).max(255),
          restore_databases: z.boolean().optional().default(false),
        })
        .safeParse(request.body);
      if (!body.success) {
        reply.code(400);
        return { error: "Yedek adı ve onay için domain adı gerekli." };
      }
      if (body.data.confirm_domain !== resolved.domain.domain_name) {
        reply.code(400);
        return { error: "Onay için domain adını birebir yazın." };
      }
      try {
        return await restoreBackup(fastify.pg, resolved.domain.domain_name, body.data.name, {
          restoreDatabases: body.data.restore_databases,
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
};

export default backupsRoutes;
