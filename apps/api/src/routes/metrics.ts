import type { FastifyPluginAsync } from "fastify";
import { metricsHistoryRangeSchema } from "@studio-panel/shared";
import { fetchHetrixUptimeMonitors } from "../lib/hetrix.js";
import { getHistory, getLatestMetrics, startMetricsSampler } from "../lib/metrics-history.js";
import { readServerHealth } from "../lib/server-health.js";

const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  // Bu uçlar sunucunun CPU/RAM/disk kullanımını ve izleme hedeflerini taşır;
  // diğer veri rotaları gibi oturum ister. (Önceden korumasızdı.)
  fastify.addHook("preHandler", fastify.requireAuth);

  startMetricsSampler();

  fastify.get("/api/metrics/resources", async (_request, reply) => {
    try {
      // Örnekleyicinin son okuması. cgroup'u burada tekrar okumuyoruz:
      // CPU yüzdesi ardışık iki okumanın farkından hesaplanıyor ve ikinci bir
      // okuyucu referans noktasını bozar. Bkz. lib/metrics-history.ts.
      return await getLatestMetrics();
    } catch (err) {
      reply.code(500);
      return { error: "cgroup metrikleri okunamadı", detail: String(err) };
    }
  });

  fastify.get("/api/metrics/history", async (request, reply) => {
    const parsed = metricsHistoryRangeSchema.safeParse(
      (request.query as { range?: string } | undefined)?.range ?? "30m",
    );
    if (!parsed.success) {
      reply.code(400);
      return { error: "Geçersiz aralık. Kullanılabilir: 5m, 30m, 1h" };
    }
    return getHistory(parsed.data);
  });

  /**
   * Sunucu sagligi: servislerin GERCEK durumu, sertifika envanteri ve
   * zamanlanmis isler. Panelde hicbiri gorunmuyordu (bkz. lib/server-health.ts).
   */
  fastify.get("/api/server/health", async () => readServerHealth());

  fastify.get("/api/metrics/uptime", async (_request, reply) => {
    const result = await fetchHetrixUptimeMonitors();
    if (!result.configured) {
      reply.code(200);
      return { status: "not_configured" as const };
    }
    if (!result.ok) {
      reply.code(502);
      return {
        status: "error" as const,
        httpStatus: result.status,
        message: result.message,
      };
    }
    return { status: "ok" as const, monitors: result.monitors };
  });
};

export default metricsRoutes;
