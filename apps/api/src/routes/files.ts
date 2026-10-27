import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getOwnedDomain, parseIdParam } from "../lib/domain.js";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import { invalidInput } from "../lib/validation.js";
import {
  FileOpError,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  createEntry,
  deleteEntries,
  deleteEntry,
  extractArchive,
  listDirectory,
  readFileContent,
  renameEntry,
  resolveDownloadTarget,
  saveUploadedStream,
  updateFileContent,
} from "../lib/files.js";

const pathQuerySchema = z.object({ path: z.string().optional().default("") });
const createBodySchema = z.object({
  path: z.string().min(1),
  isDirectory: z.boolean().optional().default(false),
  content: z.string().optional().default(""),
});
const updateBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
const renameBodySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

const filesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  async function requireOwnedDomain(request: { params: unknown; currentUser: { id: number; role: "admin" | "customer" } | null }) {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) return { error: { status: 400, body: { error: "Geçersiz domain id." } } };
    const owned = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!owned) return { error: { status: 404, body: { error: "Domain bulunamadı." } } };
    return { domain: owned };
  }

  function handleFileError(err: unknown, reply: import("fastify").FastifyReply) {
    if (err instanceof FileOpError) {
      reply.code(err.status);
      if (err.status === 403) {
        fastify.log.warn({ msg: err.message }, "path-traversal denemesi reddedildi");
      }
      return { error: err.message };
    }
    throw err;
  }

  fastify.get("/api/domains/:id/files", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const query = pathQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400);
      return { error: "Geçersiz path parametresi." };
    }
    try {
      const entries = await listDirectory(resolved.domain.domain_name, query.data.path);
      return { path: query.data.path, entries };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  fastify.get("/api/domains/:id/files/read", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const query = pathQuerySchema.safeParse(request.query);
    if (!query.success || !query.data.path) {
      reply.code(400);
      return { error: "path parametresi zorunlu." };
    }
    try {
      const content = await readFileContent(resolved.domain.domain_name, query.data.path);
      return { path: query.data.path, content };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  fastify.post("/api/domains/:id/files", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return invalidInput(body.error.issues);
    }
    try {
      await createEntry(resolved.domain.domain_name, body.data.path, body.data.isDirectory, body.data.content);
      reply.code(201);
      return { ok: true };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  fastify.put("/api/domains/:id/files", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return invalidInput(body.error.issues);
    }
    try {
      await updateFileContent(resolved.domain.domain_name, body.data.path, body.data.content);
      return { ok: true };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  fastify.delete("/api/domains/:id/files", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const query = pathQuerySchema.safeParse(request.query);
    if (!query.success || !query.data.path) {
      reply.code(400);
      return { error: "path parametresi zorunlu." };
    }
    try {
      const reaped = await deleteEntry(resolved.domain.domain_name, query.data.path);
      // Durdurulan süreçler loglanır: silinen bir klasörden sunucu çalışıyor
      // olması beklenen bir durum değil, sonradan izi sürülebilmeli.
      if (reaped.length > 0) {
        request.log.warn(
          { domain: resolved.domain.domain_name, path: query.data.path, reaped },
          "silme sırasında yolu tutan süreçler durduruldu",
        );
      }
      return { ok: true, reaped };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  // Toplu silme. Klasördeki 20 dosyayı tek tek silmek yerine seçip tek
  // istekte kalıcı siler; her yol tek tek işlenir ve başarısız olanlar
  // ayrı ayrı raporlanır.
  fastify.post("/api/domains/:id/files/bulk-delete", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const body = z
      .object({ paths: z.array(z.string().min(1)).min(1).max(2000) })
      .safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return invalidInput(body.error.issues);
    }
    try {
      const result = await deleteEntries(resolved.domain.domain_name, body.data.paths);
      if (result.reaped.length > 0) {
        request.log.warn(
          { domain: resolved.domain.domain_name, reaped: result.reaped },
          "toplu silme sırasında yolu tutan süreçler durduruldu",
        );
      }
      if (result.deleted.length === 0) {
        reply.code(400);
        return { ok: false, ...result };
      }
      return { ok: result.failed.length === 0, ...result };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  fastify.post("/api/domains/:id/files/rename", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const body = renameBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return invalidInput(body.error.issues);
    }
    try {
      await renameEntry(resolved.domain.domain_name, body.data.from, body.data.to);
      return { ok: true };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  // --- Yükleme ---
  // Çoklu dosya VE klasör. Hedef klasör multipart içindeki "path" alanından
  // gelir. Her dosyanın kendi göreli yolu (`assets/img/logo.png`) dosyadan
  // HEMEN ÖNCE gelen "relpath" alanıyla taşınır; alan yoksa part.filename'e
  // düşülür. İki durumda da ad lib/files.ts içinde segment segment
  // sanitize edilip yeniden traversal denetiminden geçirilir.
  fastify.post("/api/domains/:id/files/upload", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    if (!request.isMultipart()) {
      reply.code(400);
      return { error: "Yükleme isteği multipart/form-data olmalı." };
    }

    const saved: Array<{ name: string; size: number }> = [];
    let targetDir = "";
    let pendingRelPath: string | null = null;
    // İstemcinin bildirdiği dosya adedi. Sunucu sınırı yüzünden akış erken
    // biterse eksiği burada yakalarız — yarım yüklemeyi "başarılı" saymayız.
    let expectedCount: number | null = null;

    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "path") targetDir = String(part.value ?? "");
          else if (part.fieldname === "relpath") pendingRelPath = String(part.value ?? "");
          else if (part.fieldname === "count") {
            const parsed = Number.parseInt(String(part.value ?? ""), 10);
            expectedCount = Number.isFinite(parsed) ? parsed : null;
          }
          continue;
        }
        if (part.type !== "file") continue;

        const relName = pendingRelPath || part.filename;
        pendingRelPath = null;

        // AKITARAK yaz — dosyayı belleğe ALMA.
        //
        // Eskiden burada `await part.toBuffer()` vardı: dosyanın tamamı RAM'e
        // alınıyordu. 50 MB sınırındayken sorun değildi; sınır 2 GB'a çıkınca
        // tek bir yükleme 2 GB RAM ister ve birkaç eşzamanlı yükleme
        // konteyneri OOM'a sokar. Akıtma sabit tampon kullanır.
        const written = await saveUploadedStream(
          resolved.domain.domain_name,
          targetDir,
          relName,
          part.file,
        );

        // @fastify/multipart sınırı aşınca akışı KESER ve bayrağı kaldırır —
        // hata fırlatmaz. Bayrak akış bittikten SONRA okunabildiği için
        // kontrol yazmadan önce yapılamaz; diske düşen yarım dosyayı burada
        // siliyoruz, aksi halde kullanıcı onu tam sanır.
        if (part.file.truncated) {
          await fsp.rm(written.absolutePath, { force: true }).catch(() => {});
          reply.code(413);
          return {
            error: `"${relName}" çok büyük. Sınır ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
          };
        }
        saved.push({ name: written.name, size: written.size });
      }
    } catch (err) {
      // Dosya adedi sınırı: @fastify/multipart FST_FILES_LIMIT fırlatır.
      if ((err as { code?: string }).code === "FST_FILES_LIMIT") {
        reply.code(413);
        return {
          error: `Tek istekte en fazla ${MAX_UPLOAD_FILES} dosya yüklenebilir; klasörü parça parça gönderin.`,
        };
      }
      return handleFileError(err, reply);
    }

    if (saved.length === 0) {
      reply.code(400);
      return { error: "İstekte dosya bulunamadı." };
    }

    if (expectedCount !== null && saved.length !== expectedCount) {
      reply.code(500);
      return {
        error: `Beklenen ${expectedCount} dosyanın ${saved.length} tanesi alındı; yükleme eksik.`,
        files: saved,
      };
    }

    reply.code(201);
    return { ok: true, files: saved };
  });

  // --- Tek dosya indirme ---
  fastify.get("/api/domains/:id/files/download", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const query = pathQuerySchema.safeParse(request.query);
    if (!query.success || !query.data.path) {
      reply.code(400);
      return { error: "path parametresi zorunlu." };
    }
    try {
      const file = await resolveDownloadTarget(resolved.domain.domain_name, query.data.path);
      // Dosya adı ASCII dışı olabilir; RFC 5987 biçimi ile veriyoruz.
      const encoded = encodeURIComponent(file.fileName);
      reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", String(file.size))
        .header(
          "Content-Disposition",
          `attachment; filename="${file.fileName.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encoded}`,
        );
      return reply.send(fsSync.createReadStream(file.absolutePath));
    } catch (err) {
      return handleFileError(err, reply);
    }
  });

  // --- Arşiv açma ---
  fastify.post("/api/domains/:id/files/extract", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const body = z.object({ path: z.string().min(1) }).safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return invalidInput(body.error.issues);
    }
    try {
      const result = await extractArchive(resolved.domain.domain_name, body.data.path);
      return { ok: true, extracted: result.extracted };
    } catch (err) {
      return handleFileError(err, reply);
    }
  });
};

export default filesRoutes;
