import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getOwnedDomain, parseIdParam } from "../lib/domain.js";
import { discoverPhpVersions, validateRuntimeInput, RuntimeError } from "../lib/runtime.js";
import { invalidInput } from "../lib/validation.js";

const runtimeBodySchema = z.object({
  runtime_type: z.enum(["static", "php", "proxy"]),
  php_version: z.string().optional().nullable(),
  proxy_port: z.number().int().optional().nullable(),
});

const runtimeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/api/domains/:id/runtime", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }
    const owned = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!owned) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }
    const { rows } = await fastify.pg.query(
      "SELECT runtime_type, php_version, proxy_port FROM domains WHERE id = $1",
      [id],
    );
    return {
      runtime: rows[0],
      installedPhpVersions: await discoverPhpVersions(),
    };
  });

  fastify.put("/api/domains/:id/runtime", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }
    const owned = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!owned) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }
    const parsed = runtimeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }

    try {
      const runtime = validateRuntimeInput(parsed.data);
      await fastify.pg.query(
        "UPDATE domains SET runtime_type = $1, php_version = $2, proxy_port = $3 WHERE id = $4",
        [runtime.runtime_type, runtime.php_version, runtime.proxy_port, id],
      );
      // Ayar kaydedildi ama nginx config'i HENÜZ yeniden üretilmedi — bunu
      // yapmak için istemci POST /api/domains/:id/nginx-config çağırmalı
      // (nginxTemplate.ts render sırasında güncel runtime'ı okur). İki işlemi
      // burada birleştirmemek, kullanıcının önce ayarı görüp sonra bilinçli
      // olarak "Nginx tamamla" ile uygulamasını sağlıyor.
      return { ok: true, runtime };
    } catch (err) {
      if (err instanceof RuntimeError) {
        reply.code(err.status);
        return { error: err.message };
      }
      throw err;
    }
  });
};

export default runtimeRoutes;
