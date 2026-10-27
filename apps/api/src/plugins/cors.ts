import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(cors, {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    credentials: true,
  });
};

export default fp(corsPlugin, { name: "cors" });
