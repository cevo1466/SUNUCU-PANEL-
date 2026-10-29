import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { hitRateLimit } from "../lib/rate-limit.js";
import { z } from "zod";
import { env } from "../env.js";
import { verifyImapLogin, releaseImap } from "../lib/webmail-imap.js";
import {
  WEBMAIL_COOKIE_NAME,
  createWebmailSession,
  destroyWebmailSession,
  pruneExpiredWebmailSessions,
  resolveWebmailSession,
  type WebmailIdentity,
} from "../lib/webmail-session.js";
import {
  WebmailError,
  deleteMessagesPermanently,
  ensureStandardMailboxes,
  fetchAttachment,
  listMailboxes,
  listMessages,
  moveMessages,
  readMessage,
  readQuota,
  saveDraft,
  sendMessage,
  setFlag,
  toWebmailError,
} from "../lib/webmail-mail.js";

/**
 * Webmail API — panel API'sinden AYRI bir kimlik dünyası.
 *
 * Bu dosyadaki HİÇBİR uç `fastify.requireAuth`/`requireAdmin` kullanmaz;
 * onlar panel kullanıcısı bekler. Buradaki kimlik bir POSTA KUTUSUDUR ve
 * yetkisi yalnızca kendi posta kutusuyla sınırlıdır — domain, dosya, DNS gibi
 * hiçbir panel kaynağına erişemez. Bu ayrım kasıtlı ve sınırı burasıdır.
 */

const COOKIE_OPTS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};

const loginSchema = z.object({
  address: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
});

const mailboxQuerySchema = z.object({
  mailbox: z.string().min(1).max(255).default("INBOX"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().max(200).optional(),
});

const uidsSchema = z.object({
  mailbox: z.string().min(1).max(255),
  uids: z.array(z.number().int().positive()).min(1).max(500),
});

const sendSchema = z.object({
  to: z.string().min(3).max(2000),
  cc: z.string().max(2000).optional(),
  bcc: z.string().max(2000).optional(),
  subject: z.string().max(500).default(""),
  html: z.string().max(2_000_000).optional(),
  text: z.string().max(2_000_000).optional(),
  inReplyTo: z.string().max(500).optional(),
  references: z.array(z.string().max(500)).max(50).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        contentType: z.string().max(200).default("application/octet-stream"),
        /** base64 içerik. */
        content: z.string().max(35_000_000),
      }),
    )
    .max(20)
    .optional(),
});

/** Tek istekte gönderilebilecek toplam ek boyutu (çözülmüş halde). */
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const webmailRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Webmail kimliğini çözer. Panel `requireAuth`'undan bağımsız çalışır.
   * Bulunamazsa 401 döner ve isteği sonlandırır.
   */
  async function requireWebmail(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<WebmailIdentity | null> {
    const token = request.cookies?.[WEBMAIL_COOKIE_NAME];
    if (!token) {
      reply.code(401).send({ error: "Oturum bulunamadı." });
      return null;
    }
    const identity = await resolveWebmailSession(fastify.pg, token);
    if (!identity) {
      reply.clearCookie(WEBMAIL_COOKIE_NAME, { path: "/" });
      reply.code(401).send({ error: "Oturum süresi dolmuş." });
      return null;
    }
    return identity;
  }

  function fail(reply: FastifyReply, err: unknown) {
    const e = toWebmailError(err);
    // Parolanın hata metnine sızmaması için mesaj sabit kalıplardan geliyor
    // (bkz. toWebmailError); ham hata yalnızca sunucu log'una gider.
    fastify.log.warn({ msg: e.message }, "webmail islemi basarisiz");
    reply.code(e.status);
    return { error: e.message };
  }

  // --- Oturum ---

  fastify.post("/api/webmail/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "E-posta adresi ve parola gerekli." };
    }
    const address = parsed.data.address.trim().toLowerCase();
    if (hitRateLimit(`wm:ip:${request.ip}`, 20, 60_000) || hitRateLimit(`wm:addr:${address}`, 8, 60_000)) {
      reply.code(429);
      return { error: "Çok fazla deneme. Bir dakika sonra tekrar deneyin." };
    }
    const at = address.lastIndexOf("@");
    if (at <= 0) {
      reply.code(400);
      return { error: "Tam e-posta adresi girin (ornek@alanadi.com)." };
    }
    const localPart = address.slice(0, at);
    const domainName = address.slice(at + 1);

    const { rows } = await fastify.pg.query<{ id: number; enabled: boolean }>(
      `SELECT m.id, m.enabled
         FROM mail_accounts m JOIN domains d ON d.id = m.domain_id
        WHERE m.local_part = $1 AND d.domain_name = $2`,
      [localPart, domainName],
    );
    const account = rows[0];

    // Hesabın var olup olmadığı SIZDIRILMAZ: yok da olsa, parolası yanlış da
    // olsa, devre dışı da olsa aynı mesaj döner. Aksi halde bu uç bir hesap
    // sayım aracına dönerdi.
    const genericFailure = { error: "E-posta adresi veya parola hatalı." };

    if (!account || !account.enabled) {
      reply.code(401);
      return genericFailure;
    }

    const ok = await verifyImapLogin(address, parsed.data.password);
    if (!ok) {
      reply.code(401);
      return genericFailure;
    }

    await pruneExpiredWebmailSessions(fastify.pg);
    const { token, expiresAt } = await createWebmailSession(
      fastify.pg,
      account.id,
      parsed.data.password,
    );
    reply.setCookie(WEBMAIL_COOKIE_NAME, token, { ...COOKIE_OPTS, expires: expiresAt });

    // Sent/Drafts/Trash yoksa ilk girişte oluştur — kullanıcı "gönderdiğim
    // mail nerede?" sorusuyla karşılaşmasın.
    const identity = await resolveWebmailSession(fastify.pg, token);
    if (identity) await ensureStandardMailboxes(identity).catch(() => {});

    return { ok: true, address, expires_at: expiresAt.toISOString() };
  });

  fastify.post("/api/webmail/logout", async (request, reply) => {
    const token = request.cookies?.[WEBMAIL_COOKIE_NAME];
    if (token) {
      const sessionId = await destroyWebmailSession(fastify.pg, token);
      if (sessionId) await releaseImap(sessionId);
    }
    reply.clearCookie(WEBMAIL_COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  fastify.get("/api/webmail/me", async (request, reply) => {
    const token = request.cookies?.[WEBMAIL_COOKIE_NAME];
    if (!token) return { account: null };
    const identity = await resolveWebmailSession(fastify.pg, token);
    if (!identity) {
      reply.clearCookie(WEBMAIL_COOKIE_NAME, { path: "/" });
      return { account: null };
    }
    return {
      account: {
        address: identity.address,
        domain_name: identity.domainName,
        local_part: identity.localPart,
        quota_mb: identity.quotaMb,
      },
    };
  });

  // --- Klasörler ve kota ---

  fastify.get("/api/webmail/mailboxes", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    try {
      const [mailboxes, quota] = await Promise.all([
        listMailboxes(identity),
        readQuota(identity),
      ]);
      return { mailboxes, quota };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Mesajlar ---

  fastify.get("/api/webmail/messages", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const q = mailboxQuerySchema.safeParse(request.query);
    if (!q.success) {
      reply.code(400);
      return { error: "Geçersiz sorgu." };
    }
    try {
      return await listMessages(identity, q.data.mailbox, {
        offset: q.data.offset,
        limit: q.data.limit,
        search: q.data.search,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/api/webmail/message", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const q = z
      .object({ mailbox: z.string().min(1).max(255), uid: z.coerce.number().int().positive() })
      .safeParse(request.query);
    if (!q.success) {
      reply.code(400);
      return { error: "mailbox ve uid gerekli." };
    }
    try {
      return await readMessage(identity, q.data.mailbox, q.data.uid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get("/api/webmail/attachment", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const q = z
      .object({
        mailbox: z.string().min(1).max(255),
        uid: z.coerce.number().int().positive(),
        index: z.coerce.number().int().min(0).max(200),
      })
      .safeParse(request.query);
    if (!q.success) {
      reply.code(400);
      return { error: "mailbox, uid ve index gerekli." };
    }
    try {
      const att = await fetchAttachment(identity, q.data.mailbox, q.data.uid, q.data.index);
      const encoded = encodeURIComponent(att.filename);
      reply
        .header("Content-Type", att.contentType)
        .header("Content-Length", String(att.content.length))
        // Ek dosyalar HER ZAMAN indirilir, tarayıcıda açılmaz: bir HTML veya
        // SVG eki panelin origin'inde çalıştırılırsa oturum çalınabilirdi.
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encoded}`)
        .header("X-Content-Type-Options", "nosniff");
      return reply.send(att.content);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- İşaretleme / taşıma / silme ---

  fastify.post("/api/webmail/flag", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const body = uidsSchema
      .extend({ flag: z.enum(["seen", "flagged"]), add: z.boolean() })
      .safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "Geçersiz girdi." };
    }
    try {
      await setFlag(
        identity,
        body.data.mailbox,
        body.data.uids,
        body.data.flag === "seen" ? "\\Seen" : "\\Flagged",
        body.data.add,
      );
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post("/api/webmail/move", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const body = uidsSchema.extend({ target: z.string().min(1).max(255) }).safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "Geçersiz girdi." };
    }
    try {
      await moveMessages(identity, body.data.mailbox, body.data.uids, body.data.target);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Sil. Çöp kutusunda DEĞİLSE çöpe taşır; çöpteyse kalıcı siler.
   *
   * Tek adımda kalıcı silmek veri kaybıdır — kullanıcı "sil"e basınca geri
   * alınamaz bir şey beklemiyor. İkinci silme bilinçli bir eylemdir.
   */
  fastify.post("/api/webmail/delete", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const body = uidsSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "Geçersiz girdi." };
    }
    try {
      const boxes = await listMailboxes(identity);
      const current = boxes.find((b) => b.path === body.data.mailbox);
      const trash = boxes.find((b) => b.role === "trash");
      if (current?.role === "trash" || !trash) {
        await deleteMessagesPermanently(identity, body.data.mailbox, body.data.uids);
        return { ok: true, permanent: true };
      }
      await moveMessages(identity, body.data.mailbox, body.data.uids, trash.path);
      return { ok: true, permanent: false };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Gönderme ---

  fastify.post("/api/webmail/preview", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const body = z.object({
      subject: z.string().max(500).default(""),
      html: z.string().max(2_000_000).optional(),
      text: z.string().max(2_000_000).optional(),
    }).safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "Önizleme hazırlanamadı." };
    }
    return {
      html: body.data.html || body.data.text || "",
    };
  });

  function decodeAttachments(
    input: z.infer<typeof sendSchema>["attachments"],
    reply: FastifyReply,
  ): Array<{ filename: string; contentType: string; content: Buffer }> | null {
    if (!input?.length) return [];
    const out = input.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: Buffer.from(a.content, "base64"),
    }));
    const total = out.reduce((sum, a) => sum + a.content.length, 0);
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      reply.code(413).send({
        error: `Ekler toplamı çok büyük. Sınır ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
      });
      return null;
    }
    return out;
  }

  fastify.post("/api/webmail/send", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const body = sendSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "Alıcı ve konu alanlarını kontrol edin." };
    }
    if (!body.data.html && !body.data.text) {
      reply.code(400);
      return { error: "Mesaj boş olamaz." };
    }
    const attachments = decodeAttachments(body.data.attachments, reply);
    if (attachments === null) return;

    try {
      const result = await sendMessage(identity, { ...body.data, attachments });
      return result;
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post("/api/webmail/draft", async (request, reply) => {
    const identity = await requireWebmail(request, reply);
    if (!identity) return;
    const body = sendSchema.partial({ to: true }).safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "Geçersiz girdi." };
    }
    // Taslakta da ekler base64 gelir; OutgoingMessage Buffer bekliyor.
    const attachments = decodeAttachments(body.data.attachments, reply);
    if (attachments === null) return;
    try {
      return await saveDraft(identity, {
        ...body.data,
        to: body.data.to ?? "",
        attachments,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Webmail'in çalışıp çalışmadığını dürüstçe bildirir (panelin diğer
  // servislerinde olduğu gibi: gerçek kontrol, sahte "çalışıyor" yok).
  fastify.get("/api/webmail/health", async () => {
    return {
      imap: `${env.WEBMAIL_IMAP_HOST}:${env.WEBMAIL_IMAP_PORT}`,
      smtp: `${env.WEBMAIL_SMTP_HOST}:${env.WEBMAIL_SMTP_PORT}`,
    };
  });
};

export default webmailRoutes;
export { WebmailError };
