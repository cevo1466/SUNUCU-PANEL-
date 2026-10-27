import { invalidInput } from "../lib/validation.js";
import { passwordField } from "@studio-panel/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { getOwnedDomain, parseIdParam } from "../lib/domain.js";
import { mailboxUsages, webmailHasHttps, webmailUrl } from "../lib/mail-usage.js";
import { checkMailDns, ensureMailDns } from "../lib/mail-dns.js";
import {
  DEFAULT_QUOTA_MB,
  MailError,
  applyMailReload,
  assertValidLocalPart,
  generatePassword,
  hashPassword,
  mailAddress,
  mailServerStatus,
  maildirPath,
  normalizeLocalPart,
  suggestLocalPart,
  writeDovecotUsers,
  type MailAccountRow,
} from "../lib/mail.js";

const quotaField = z.number().int().min(10).max(1_048_576).nullable();

const createSchema = z.object({
  localPart: z.string().trim().min(1).max(64),
  password: passwordField.optional(),
  // Yalnizca admin gonderebilir; kontrol handler'da (bkz. assertMaySetQuota).
  quotaMb: quotaField.optional(),
});

/**
 * `.strict()` BILINCLI: musteri bu uca `quotaMb` koyarsa zod varsayilani olan
 * SESSIZ "strip" davranisi devreye girer ve alan yok sayilirdi — kullanici
 * kotayi ayarladigini sanip yanilirdi. Fazladan alan 400 ile reddedilir.
 */
const updateSchema = z
  .object({
    password: passwordField.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

const quotaSchema = z.object({ quotaMb: quotaField });

function publicAccount(row: MailAccountRow, domainName: string) {
  // password_hash cevaba ASLA girmez.
  return {
    id: row.id,
    domain_id: row.domain_id,
    local_part: row.local_part,
    address: mailAddress(row.local_part, domainName),
    maildir: maildirPath(domainName, row.local_part),
    quota_mb: row.quota_mb,
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

const SELECT_COLS = "id, domain_id, local_part, quota_mb, enabled, created_at";

const mailRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  /**
   * Kotayi YALNIZCA yonetici belirleyebilir (kullanicinin acik istegi).
   *
   * Sessizce yok saymak yerine 403 doner: musteri formda 100 MB yazip 201
   * alsa ve listede "Sinirsiz" gorse, sunucu istegi kabul etmis gibi davranip
   * yapmamis olurdu — projenin yasakladigi "numara yapma" davranisinin API
   * surumu. Kotanin kanonik yolu ayri bir uctur (PATCH .../quota) ve orada
   * yetki route tablosunda GORUNUR halde `requireAdmin` ile bagli.
   */
  function assertMaySetQuota(role: string): void {
    if (role !== "admin") {
      throw new MailError("E-posta kotasını yalnızca yönetici belirleyebilir.", 403);
    }
  }

  fastify.get("/api/domains/:id/mail", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }
    const domain = await getOwnedDomain(
      fastify.pg,
      id,
      request.currentUser!.id,
      request.currentUser!.role,
    );
    if (!domain) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    const [{ rows }, defaults] = await Promise.all([
      fastify.pg.query<MailAccountRow>(
        `SELECT ${SELECT_COLS} FROM mail_accounts WHERE domain_id = $1 ORDER BY local_part`,
        [id],
      ),
      fastify.pg.query<{ mail_quota_default_mb: number | null }>(
        "SELECT mail_quota_default_mb FROM domains WHERE id = $1",
        [id],
      ),
    ]);

    // Posta kutusu doluluklari: kullanicinin parolasi gerekmeden, maildir'in
    // disk kullanimindan olculur (bkz. lib/mail-usage.ts). Onbellekli oldugu
    // icin liste her acilista `du` calistirmaz.
    const usages = await mailboxUsages(
      domain.domain_name,
      rows.map((r) => r.local_part),
    );

    return {
      accounts: rows.map((row, index) => ({
        ...publicAccount(row, domain.domain_name),
        // null = olculemedi. Arayuz bunu "0 bayt" gibi GOSTERMEZ.
        used_bytes: usages[index]?.bytes ?? null,
        usage_error: usages[index]?.error ?? null,
      })),
      suggestedLocalPart: suggestLocalPart(rows.map((r) => r.local_part)),
      defaultQuotaMb: defaults.rows[0]?.mail_quota_default_mb ?? null,
      canSetQuota: request.currentUser!.role === "admin",
      service: await mailServerStatus(),
      // Webmail adresi domain basina; sema HTTPS gercekten yayindaysa https.
      webmail: {
        url: webmailUrl(domain.domain_name),
        https: webmailHasHttps(domain.domain_name),
      },
      // Posta DNS'inin GERCEK durumu — panelin kaydina degil DNS'e bakilir.
      // Kayitlar eksikken panel her seyi yolunda gosteriyordu: MX yoksa
      // disaridan posta gelmez, SPF/DKIM/DMARC yoksa giden posta
      // "gonderen dogrulanamadi" damgasi yer (2026-09-02).
      dns: await checkMailDns(domain.domain_name),
    };
  });

  /**
   * Eksik posta DNS kayitlarini gercek saglayiciya yazar.
   *
   * Hesap acilirken de KENDILIGINDEN calisir (bkz. POST .../mail); bu uc
   * elle tetiklemek ve sonucu gormek icin.
   */
  fastify.post("/api/domains/:id/mail/dns", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }
    const domain = await getOwnedDomain(
      fastify.pg,
      id,
      request.currentUser!.id,
      request.currentUser!.role,
    );
    if (!domain) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }
    const fix = await ensureMailDns(fastify.pg, domain.id, domain.domain_name);
    return { ok: true, ...fix, dns: await checkMailDns(domain.domain_name) };
  });

  fastify.post("/api/domains/:id/mail", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    const parsed = createSchema.safeParse(request.body);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }
    if (!parsed.success) {
      // Mesaj SEMADAN uretiliyor. Elle yazilmis uzunluk metni, kural
      // gevsetildikten sonra da eski sayiyi soyluyordu (2026-09-02):
      // kullanici "Melih135." yaziyor, sunucu kabul ediyor ama reddettigi
      // durumlarda eski siniri gosteriyordu. Sayiyi metne gomen her mesaj
      // kural degisiminde sessizce yalan soyler.
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }
    const domain = await getOwnedDomain(
      fastify.pg,
      id,
      request.currentUser!.id,
      request.currentUser!.role,
    );
    if (!domain) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    try {
      if (parsed.data.quotaMb !== undefined) assertMaySetQuota(request.currentUser!.role);

      const localPart = normalizeLocalPart(parsed.data.localPart);
      assertValidLocalPart(localPart);
      const password = parsed.data.password ?? generatePassword();
      const passwordHash = await hashPassword(password);

      const client = await fastify.pg.connect();
      try {
        await client.query("BEGIN");
        // Kota gonderilmediyse domain varsayilani, o da yoksa modul
        // varsayilani devralinir — musterinin actigi hesap SESSIZCE sinirsiz
        // dogmasin.
        const { rows: defaults } = await client.query<{ mail_quota_default_mb: number | null }>(
          "SELECT mail_quota_default_mb FROM domains WHERE id = $1",
          [id],
        );
        const quota =
          parsed.data.quotaMb !== undefined
            ? parsed.data.quotaMb
            : (defaults[0]?.mail_quota_default_mb ?? DEFAULT_QUOTA_MB);

        const { rows } = await client.query<MailAccountRow>(
          `INSERT INTO mail_accounts (domain_id, local_part, password_hash, quota_mb)
           VALUES ($1, $2, $3, $4)
           RETURNING ${SELECT_COLS}`,
          [id, localPart, passwordHash, quota],
        );
        // COMMIT'ten ONCE ve AYNI client ile: uretilen dosya bu transaction'in
        // gorunumunden yenilenmezse yeni hesap dosyada olmazdi.
        await writeDovecotUsers(client, env.VHOSTS_ROOT);
        await client.query("COMMIT");
        const reload = await applyMailReload();
        // POSTA DNS'INI KENDILIGINDEN TAMAMLA.
        //
        // Hesap acmak tek basina yetmiyor: MX yoksa bu adrese disaridan
        // posta gelmez, SPF/DKIM/DMARC yoksa giden posta dogrulanamaz.
        // Panel kayitlari zaten planlamis durumda; eksik olan onlari gercek
        // saglayiciya yazmakti. Basarisizlik OLUMCUL DEGIL — hesap acildi,
        // eksik kayitlar cevapta bildirilir.
        const dnsFix = await ensureMailDns(fastify.pg, domain.id, domain.domain_name).catch(
          (err: Error) => ({ created: 0, failed: [], warnings: [], unavailable: err.message }),
        );
        reply.code(201);
        return {
          account: publicAccount(rows[0], domain.domain_name),
          password,
          service: await mailServerStatus(),
          reload,
          dnsFix,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        reply.code(409);
        return { error: "Bu e-posta adresi bu domainde zaten var." };
      }
      if (error instanceof MailError) {
        reply.code(error.status);
        return { error: error.message };
      }
      throw error;
    }
  });

  fastify.patch("/api/domains/:id/mail/:accountId", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    const accountId = parseIdParam((request.params as { accountId: string }).accountId);
    const parsed = updateSchema.safeParse(request.body);
    if (id === null || accountId === null || !parsed.success) {
      reply.code(400);
      return {
        error:
          "Geçerli parola veya durum değeri gerekli. Kota bu uçtan değiştirilemez; " +
          "yöneticiyseniz kota ucunu kullanın.",
      };
    }
    const domain = await getOwnedDomain(
      fastify.pg,
      id,
      request.currentUser!.id,
      request.currentUser!.role,
    );
    if (!domain) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    try {
      const passwordHash = parsed.data.password ? await hashPassword(parsed.data.password) : null;
      const client = await fastify.pg.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<MailAccountRow>(
          `UPDATE mail_accounts SET
             password_hash = COALESCE($1, password_hash),
             enabled = COALESCE($2, enabled)
           WHERE id = $3 AND domain_id = $4
           RETURNING ${SELECT_COLS}`,
          [passwordHash, parsed.data.enabled ?? null, accountId, id],
        );
        if (!rows[0]) {
          await client.query("ROLLBACK");
          reply.code(404);
          return { error: "E-posta hesabı bulunamadı." };
        }
        await writeDovecotUsers(client, env.VHOSTS_ROOT);
        await client.query("COMMIT");
        const reload = await applyMailReload();
        return {
          account: publicAccount(rows[0], domain.domain_name),
          password: parsed.data.password,
          reload,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof MailError) {
        reply.code(error.status);
        return { error: error.message };
      }
      throw error;
    }
  });

  // Kotanin kanonik yolu. requireAdmin route tablosunda GORUNUR — bir `if`
  // dalina gomulu olsaydi ileride handler duzenlenirken kazara kaldirilabilirdi.
  fastify.patch(
    "/api/domains/:id/mail/:accountId/quota",
    { preHandler: fastify.requireAdmin },
    async (request, reply) => {
      const id = parseIdParam((request.params as { id: string }).id);
      const accountId = parseIdParam((request.params as { accountId: string }).accountId);
      const parsed = quotaSchema.safeParse(request.body);
      if (id === null || accountId === null || !parsed.success) {
        reply.code(400);
        return { error: "Geçerli kota değeri gerekli (10-1048576 MB veya null)." };
      }
      const domain = await getOwnedDomain(
        fastify.pg,
        id,
        request.currentUser!.id,
        request.currentUser!.role,
      );
      if (!domain) {
        reply.code(404);
        return { error: "Domain bulunamadı." };
      }

      const client = await fastify.pg.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<MailAccountRow>(
          `UPDATE mail_accounts SET quota_mb = $1 WHERE id = $2 AND domain_id = $3
           RETURNING ${SELECT_COLS}`,
          [parsed.data.quotaMb, accountId, id],
        );
        if (!rows[0]) {
          await client.query("ROLLBACK");
          reply.code(404);
          return { error: "E-posta hesabı bulunamadı." };
        }
        // Kota degisimi uretilen dosyayi da etkiler (storage=NNNM).
        await writeDovecotUsers(client, env.VHOSTS_ROOT);
        await client.query("COMMIT");
        const reload = await applyMailReload();
        return { account: publicAccount(rows[0], domain.domain_name), reload };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  fastify.put(
    "/api/domains/:id/mail/quota-default",
    { preHandler: fastify.requireAdmin },
    async (request, reply) => {
      const id = parseIdParam((request.params as { id: string }).id);
      const parsed = quotaSchema.safeParse(request.body);
      if (id === null || !parsed.success) {
        reply.code(400);
        return { error: "Geçerli varsayılan kota değeri gerekli." };
      }
      const { rows } = await fastify.pg.query<{ mail_quota_default_mb: number | null }>(
        "UPDATE domains SET mail_quota_default_mb = $1 WHERE id = $2 RETURNING mail_quota_default_mb",
        [parsed.data.quotaMb, id],
      );
      if (!rows[0]) {
        reply.code(404);
        return { error: "Domain bulunamadı." };
      }
      return { defaultQuotaMb: rows[0].mail_quota_default_mb };
    },
  );

  fastify.delete("/api/domains/:id/mail/:accountId", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    const accountId = parseIdParam((request.params as { accountId: string }).accountId);
    if (id === null || accountId === null) {
      reply.code(400);
      return { error: "Geçersiz hesap id." };
    }
    if (
      !(await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role))
    ) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "DELETE FROM mail_accounts WHERE id = $1 AND domain_id = $2",
        [accountId, id],
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: "E-posta hesabı bulunamadı." };
      }
      await writeDovecotUsers(client, env.VHOSTS_ROOT);
      await client.query("COMMIT");
      const reload = await applyMailReload();
      return { ok: true, reload };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
};

export default mailRoutes;
