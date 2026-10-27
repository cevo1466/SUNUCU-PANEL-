import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AdminerError, getAdminerStatus, setAdminerPhpBin } from "../lib/adminer.js";
import { invalidInput } from "../lib/validation.js";

const phpBinBodySchema = z.object({ php_bin: z.string().min(1) });

const adminerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/api/adminer", async () => {
    return getAdminerStatus();
  });

  fastify.post("/api/adminer/php-version", async (request, reply) => {
    const parsed = phpBinBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }
    try {
      const settings = await setAdminerPhpBin(parsed.data.php_bin);
      return { ok: true, settings };
    } catch (err) {
      if (err instanceof AdminerError) {
        reply.code(err.status);
        return { error: err.message };
      }
      throw err;
    }
  });
};

export default adminerRoutes;
