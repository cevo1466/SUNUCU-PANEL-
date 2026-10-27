import type { FastifyPluginAsync } from "fastify";

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/health", async (_request, reply) => {
    try {
      await fastify.pg.query("SELECT 1");
    } catch (err) {
      // Bağlantı dizesi, host veya sürücü ayrıntıları public health yanıtına
      // sızmaz; ayrıntı correlation id ile yalnızca sunucu logundadır.
      _request.log.error({ err, requestId: _request.id }, "health database check failed");
      reply.code(503);
      return { status: "error", db: "unreachable", requestId: _request.id };
    }
    return { status: "ok", db: "connected" };
  });
};

export default healthRoutes;
