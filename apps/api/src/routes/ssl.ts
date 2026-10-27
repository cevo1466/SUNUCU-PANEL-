import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PROJECT_ROOT } from "../env.js";
import { GENERATED_DIR, getOwnedDomain, parseIdParam } from "../lib/domain.js";
import { prepareSslHosts, type HostPrep } from "../lib/ssl-dns.js";

const execFileAsync = promisify(execFile);

const markIssuedSchema = z.object({
  expiresAt: z.iso.datetime(),
});

const SSL_ISSUE_SCRIPT = path.join(PROJECT_ROOT, "ops", "scripts", "ssl-issue.sh");
/** Islem gecmisi (istek + SONUC). Eskiden yalnizca "istek" yazilirdi. */
const SSL_LOG = path.join(GENERATED_DIR, "pending-ssl-requests.jsonl");

/**
 * Certbot'un gercek suresi. ACME dogrulamasi, DNS gecikmesi ve nginx reload
 * dahil; 90 sn'lik proje hedefinin iki kati pay birakiyor. Bu sureyi asan bir
 * calisma zaten takilmistir ve kullaniciyi sonsuza kadar bekletmemeli.
 */
const ISSUE_TIMEOUT_MS = 180_000;

/**
 * Script'in son satiri:
 *   `SSL_RESULT domain=... expiry=2026-11-27T18:57:00Z www=1 webmail=kuruldu`
 * Bitis tarihi ARTIK KULLANICIYA SORULMUYOR, sertifikadan okunuyor.
 */
function parseExpiry(stdout: string): Date | null {
  const match = /^SSL_RESULT .*\bexpiry=(\S+)/m.exec(stdout);
  if (!match) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Sertifika `www.<domain>` adini da kapsiyor mu. */
function parseWww(stdout: string): boolean {
  return /^SSL_RESULT .*\bwww=1\b/m.test(stdout);
}

/**
 * Webmail sertifikasinin sonucu. Arayuz bunu OLDUGU GIBI gosterir: "kuruldu"
 * demek kolaydi ama DNS kaydi olmadigi icin atlandiginda kullanici sebebini
 * gormeden "HTTPS yok" rozetiyle bas basa kaliyordu.
 */
type WebmailOutcome = "kuruldu" | "dns-yok" | "basarisiz" | "atlandi";
function parseWebmail(stdout: string): WebmailOutcome {
  const match = /^SSL_RESULT .*\bwebmail=(\S+)/m.exec(stdout);
  const value = match?.[1];
  return value === "kuruldu" || value === "dns-yok" || value === "basarisiz"
    ? value
    : "atlandi";
}

/**
 * Kullaniciya gosterilecek sebep. ssl-issue.sh her cikis yolunda stderr'e tek
 * satirlik `HATA: ...` yazar; onu tercih ederiz. Yoksa certbot'un kendi
 * ciktisinin sonu, o da yoksa sudo/exec hatasi.
 *
 * NOT: bu mesaj 4xx ile donmeli. Web istemcisi (apps/web/src/lib/api.ts)
 * 5xx govdelerini "Panel API servisi gecici olarak kullanilamiyor" ile
 * DEGISTIRIYOR — 500 donersek kullanici gercek sebebi hicbir zaman gormez.
 */
function failureReason(err: unknown): string {
  const holder = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
  const stderr = (holder?.stderr ?? "").trim();
  const hata = stderr
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("HATA:"));
  if (hata) return hata.replace(/^HATA:\s*/, "");
  if (holder?.killed) return `İşlem ${ISSUE_TIMEOUT_MS / 1000} saniyede tamamlanmadı ve durduruldu.`;
  if (stderr) return stderr.split("\n").slice(-3).join(" ").slice(0, 500);
  const stdout = (holder?.stdout ?? "").trim();
  if (stdout) return stdout.split("\n").slice(-3).join(" ").slice(0, 500);
  return holder?.message ?? "Sertifika alınamadı.";
}

const sslRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/api/domains/:id/ssl", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }

    const { rows } = await fastify.pg.query(
      `SELECT id, domain_name, ssl_status, ssl_expiry
         FROM domains WHERE id = $1 AND user_id = $2`,
      [id, request.currentUser!.id],
    );
    if (!rows[0]) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }
    return { ssl: rows[0] };
  });

  /**
   * Sertifikayi GERCEKTEN alir ve kurar.
   *
   * 2026-09-01 oncesinde bu uc yalnizca ops/generated/pending-ssl-requests.jsonl
   * dosyasina bir satir yazip 202 donuyordu; "operator sunucuda calistirsin"
   * deniyordu ama calistiran olmadi — dosyada isleme alinmamis 88 istek
   * birikmisti. Artik dar kapsamli bir sudo kuraliyla
   * (/etc/sudoers.d/studio-panel-ssl) ops/scripts/ssl-issue.sh calistirilir;
   * script domain adini kendi icinde tekrar dogrular.
   */
  fastify.post("/api/domains/:id/ssl/request", async (request, reply) => {
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

    const startedAt = new Date();

    // ONCE DNS, SONRA SERTIFIKA.
    //
    // `www.` ve `webmail.` adlari cozumlenmiyorsa sertifikaya girmiyorlar ve
    // panel her seferinde "HTTPS yok" diyordu — kullanicidan Cloudflare'e
    // girip eli ile kayit acmasi bekleniyordu. Panelin Cloudflare token'i var;
    // eksik kaydi kendisi aciyor. Basarisizligi OLUMCUL DEGIL: asil alan
    // adinin sertifikasi yine alinir, eksik kalan ad ayrica bildirilir.
    const dnsPrep = await prepareSslHosts(domain.domain_name);

    let stdout = "";
    try {
      const result = await execFileAsync("sudo", ["-n", SSL_ISSUE_SCRIPT, domain.domain_name], {
        timeout: ISSUE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      const reason = failureReason(err);
      await appendLog({
        domain_id: domain.id,
        domain_name: domain.domain_name,
        requested_by: request.currentUser!.id,
        requested_at: startedAt.toISOString(),
        status: "failed",
        error: reason,
      });
      // 409: istemci 5xx govdelerini genel bir mesajla degistiriyor, sebep
      // kaybolurdu. Bu bir sunucu arizasi degil, on kosul/dogrulama hatasi.
      reply.code(409);
      return { error: reason };
    }

    const expiry = parseExpiry(stdout);
    if (!expiry) {
      // Script 0 ile cikti ama sonucu bildirmedi — "basarili" demek yalan olur.
      await appendLog({
        domain_id: domain.id,
        domain_name: domain.domain_name,
        requested_by: request.currentUser!.id,
        requested_at: startedAt.toISOString(),
        status: "failed",
        error: "Script sonucu bildirmedi (SSL_RESULT satırı yok).",
      });
      reply.code(409);
      return {
        error:
          "Sertifika alındı görünüyor ama panel bitiş tarihini okuyamadı. Sunucuda 'sudo ops/scripts/ssl-issue.sh " +
          `${domain.domain_name}' çıktısını kontrol edin.`,
      };
    }

    const { rows } = await fastify.pg.query(
      `UPDATE domains SET ssl_status = TRUE, ssl_expiry = $1
         WHERE id = $2
       RETURNING id, domain_name, ssl_status, ssl_expiry`,
      [expiry, domain.id],
    );

    await appendLog({
      domain_id: domain.id,
      domain_name: domain.domain_name,
      requested_by: request.currentUser!.id,
      requested_at: startedAt.toISOString(),
      status: "issued",
      expiry: expiry.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
    });

    return {
      ok: true,
      status: "issued" as const,
      ssl: rows[0],
      /** Sertifika www adini da kapsiyor mu. */
      www: parseWww(stdout),
      /** SSL oncesi DNS hazirligi — hangi ad acildi, hangisi acilamadi. */
      dns: dnsPrep,
      /** webmail.<domain> sertifikasinin sonucu — bkz. WebmailOutcome. */
      webmail: parseWebmail(stdout),
      /** Script'in insan tarafindan okunabilir ciktisi — arayuz detay olarak gosterir. */
      log: stdout.trim().split("\n").slice(-20).join("\n"),
    };
  });

  async function appendLog(entry: Record<string, unknown>) {
    try {
      await fs.mkdir(GENERATED_DIR, { recursive: true });
      await fs.appendFile(SSL_LOG, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Gecmis kaydi tutulamazsa islem yine de gecerlidir; sessizce gecilir.
    }
  }

  /**
   * Panel disinda kurulmus (ornegin baska bir CA'dan alinmis) bir sertifikayi
   * elle isaretlemek icin. Panelin kendi akisi artik tarihi sertifikadan
   * okuyor, bu uc yalnizca dis sertifikalar icin duruyor.
   */
  fastify.post("/api/domains/:id/ssl/mark-issued", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    const parsed = markIssuedSchema.safeParse(request.body);
    if (id === null || !parsed.success) {
      reply.code(400);
      return { error: "Geçerli bir domain id ve ISO expiresAt değeri gerekli." };
    }
    const expiresAt = new Date(parsed.data.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      reply.code(400);
      return { error: "Sertifika bitiş tarihi gelecekte olmalı." };
    }

    const { rows } = await fastify.pg.query(
      `UPDATE domains SET ssl_status = TRUE, ssl_expiry = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, domain_name, ssl_status, ssl_expiry`,
      [expiresAt, id, request.currentUser!.id],
    );
    if (!rows[0]) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }
    return { ssl: rows[0] };
  });
};

export default sslRoutes;
