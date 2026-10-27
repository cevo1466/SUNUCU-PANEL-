import fp from "fastify-plugin";
import { Pool } from "pg";
import type { FastifyPluginAsync } from "fastify";
import { env } from "../env.js";

declare module "fastify" {
  interface FastifyInstance {
    pg: Pool;
  }
}

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  // Idle client'larda beklenmedik bağlantı kopması (örn. sunucu durdurulması)
  // process'i "unhandled 'error' event" ile çökertmesin.
  pool.on("error", (err) => {
    fastify.log.error({ err }, "pg pool idle client error");
  });

  // Bağlantıyı erken doğrula — sessizce "bağlıyım" varsayma.
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }

  fastify.decorate("pg", pool);
  fastify.addHook("onClose", async () => {
    await pool.end();
  });
};

export default fp(dbPlugin, { name: "db" });
