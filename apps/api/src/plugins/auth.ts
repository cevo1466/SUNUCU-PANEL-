import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { FastifyPluginAsync } from "fastify";
import { env } from "../env.js";
import { resolveSession, SESSION_COOKIE_NAME } from "../lib/session.js";

export interface CurrentUser {
  id: number;
  username: string;
  email: string;
  role: "admin" | "customer";
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(cookie, {
    secret: env.SESSION_SECRET,
    hook: "onRequest",
  });

  fastify.decorateRequest("currentUser", null);

  fastify.addHook("onRequest", async (request) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) {
      request.currentUser = null;
      return;
    }
    request.currentUser = await resolveSession(fastify.pg, token);
  });

  fastify.decorate(
    "requireAuth",
    async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      if (!request.currentUser) {
        reply.code(401).send({ error: "Yetkisiz — giriş yapmalısınız." });
      }
    },
  );

  // Domain başına müşteri girişleri eklendiği için bazı işlemler (domain
  // oluşturma/silme, müşteri hesabı yönetimi) yalnızca admin'e açık kalmalı —
  // aksi halde bir müşteri kendi domainini silebilir veya yeni domain açabilirdi.
  fastify.decorate(
    "requireAdmin",
    async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      if (!request.currentUser) {
        reply.code(401).send({ error: "Yetkisiz — giriş yapmalısınız." });
        return;
      }
      if (request.currentUser.role !== "admin") {
        reply.code(403).send({ error: "Bu işlem yalnızca yönetici hesabına açık." });
      }
    },
  );
};

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => Promise<void>;
    requireAdmin: (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => Promise<void>;
  }
}

export default fp(authPlugin, { name: "auth", dependencies: ["db"] });
