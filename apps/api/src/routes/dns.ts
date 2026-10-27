import type { FastifyPluginAsync } from "fastify";
import { createDnsRecordInputSchema, updateDnsRecordInputSchema } from "@studio-panel/shared";
import { getOwnedDomain, parseIdParam } from "../lib/domain.js";
import { getCloudflareClient, CloudflareError, type CloudflareClient, type CloudflareZone } from "../lib/cloudflare.js";
import { pullDnsRecordsFromCloudflare, resolveZoneForDomain } from "../lib/dns-sync.js";
import { applyDomainLocalDns, pushDomainDnsToCloudflare, toCloudflarePayload } from "../lib/dnsProvision.js";
import { isZoneDeployed, isZoneGenerated } from "../lib/localDns.js";
import { env } from "../env.js";
import { invalidInput } from "../lib/validation.js";

/**
 * Token'ın izni yetmiyor mu, yoksa Cloudflare mi arızalı?
 *
 * Ayrımı yapıyoruz çünkü kullanıcının atacağı adım tamamen farklı: izin
 * hatasında token'a yetki eklenir, arıza durumunda beklenir. Canlıda görülen
 * hata `code 10000 Authentication error` ile HTTP 403 idi — token zone
 * listesini okuyabiliyor ama DNS kayıtlarını okuyamıyordu.
 */
function isCloudflarePermissionError(err: CloudflareError): boolean {
  if (err.status === 401 || err.status === 403) return true;
  // 10000 = Authentication error, 9109 = unauthorized to access requested resource
  return err.errors.some((e) => e.code === 10000 || e.code === 9109);
}

interface DbDnsRecord {
  record_type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority: number | null;
  weight: number | null;
  port: number | null;
}

/** Tek bir kaydı gerçek Cloudflare hesabına yazar — sadece tekil oluşturma route'u kullanır (toplu gönderim lib/dnsProvision.ts'teki pushDomainDnsToCloudflare'de). */
async function pushSingleRecordToCloudflare(
  client: CloudflareClient,
  zone: CloudflareZone,
  record: DbDnsRecord,
): Promise<string> {
  const created = await client.createDnsRecord(zone.id, toCloudflarePayload(record));
  return created.id;
}

const dnsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  async function requireOwnedDomain(request: { params: unknown; currentUser: { id: number; role: "admin" | "customer" } | null }) {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) return { error: { status: 400, body: { error: "Geçersiz domain id." } } };
    const owned = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!owned) return { error: { status: 404, body: { error: "Domain bulunamadı." } } };
    return { domain: owned };
  }

  // Yerel DB'deki kayıtlar (Cloudflare'e hiç istek atmaz).
  fastify.get("/api/domains/:id/dns", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const { rows } = await fastify.pg.query(
      `SELECT id, domain_id, record_type, name, content, ttl, priority, weight, port, proxied, cloudflare_id, synced_at
         FROM dns_records WHERE domain_id = $1 ORDER BY id`,
      [resolved.domain.id],
    );
    return { records: rows };
  });

  // GERÇEK ama SALT-OKUNUR Cloudflare çağrısı: yapılandırılmış mı, zone
  // bulundu mu, zone'da kaç kayıt var. Hiçbir şey YAZMAZ.
  fastify.get("/api/domains/:id/dns/cloudflare-status", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const client = getCloudflareClient();
    try {
      const { configured, zone } = await resolveZoneForDomain(client, resolved.domain.domain_name);
      if (!configured) return { status: "not_configured" as const };
      if (!zone) return { status: "zone_not_found" as const, domain: resolved.domain.domain_name };
      const liveRecords = await client.listDnsRecords(zone.id);
      return {
        status: "ok" as const,
        zone: { id: zone.id, name: zone.name, status: zone.status },
        liveRecordCount: liveRecords.length,
      };
    } catch (err) {
      if (err instanceof CloudflareError) {
        // Bilerek 200: bu ucun işi Cloudflare'in DURUMUNU bildirmek.
        // Erişilebilen ama izin vermeyen bir Cloudflare, başarılı bir durum
        // raporudur — ağ geçidi arızası değil. 502 döndürüldüğünde arayüz
        // bunu taşıma hatası sayıp YEREL DNS kayıtlarını da gizliyordu.
        return {
          status: "error" as const,
          httpStatus: err.status,
          message: err.message,
          // Token'a izin eklenmesi gerektiğini arayüzün ayırt edebilmesi için.
          reason: isCloudflarePermissionError(err) ? ("permission" as const) : ("upstream" as const),
        };
      }
      throw err;
    }
  });

  // Cloudflare -> panel: GERÇEK okuma + yerel DB'ye yazma. Cloudflare'e
  // hiçbir yazma isteği ATMAZ, bu yüzden prod hesabına karşı güvenle
  // çalıştırılabilir (bkz. MEMORY.md Oturum 5).
  fastify.post("/api/domains/:id/dns/pull", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const client = getCloudflareClient();
    try {
      const result = await pullDnsRecordsFromCloudflare(
        fastify.pg,
        client,
        resolved.domain.id,
        resolved.domain.domain_name,
      );
      return result;
    } catch (err) {
      if (err instanceof CloudflareError) {
        reply.code(502);
        return { status: "error", message: err.message };
      }
      throw err;
    }
  });

  // Panel -> Cloudflare: GERÇEK yazma çağrısı yapar (zone bulunursa).
  // ⚠️ Bu route bu sandbox'ta hiç ÇAĞRILMADI — bkz. lib/cloudflare.self-test.ts
  // (yerel mock sunucu) ve MEMORY.md (canlı hesaba karşı bilinçli olarak
  // hiç create/update/delete denenmedi).
  fastify.post("/api/domains/:id/dns", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const parsed = createDnsRecordInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }
    const { record_type, name, content, ttl, proxied, priority, weight, port } = parsed.data;

    const client = getCloudflareClient();
    let cloudflareId: string | null = null;
    let cloudflareStatus: "not_configured" | "zone_not_found" | "synced" = "not_configured";

    try {
      const { configured, zone } = await resolveZoneForDomain(client, resolved.domain.domain_name);
      if (configured && zone) {
        cloudflareId = await pushSingleRecordToCloudflare(client, zone, {
          record_type,
          name,
          content,
          ttl,
          proxied,
          priority: priority ?? null,
          weight: weight ?? null,
          port: port ?? null,
        });
        cloudflareStatus = "synced";
      } else if (configured) {
        cloudflareStatus = "zone_not_found";
      }
    } catch (err) {
      if (err instanceof CloudflareError) {
        reply.code(502);
        return { error: `Cloudflare'e yazılamadı: ${err.message}` };
      }
      throw err;
    }

    const { rows } = await fastify.pg.query(
      `INSERT INTO dns_records (domain_id, record_type, name, content, ttl, priority, weight, port, proxied, cloudflare_id, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
       RETURNING id, domain_id, record_type, name, content, ttl, priority, weight, port, proxied, cloudflare_id, synced_at`,
      [resolved.domain.id, record_type, name, content, ttl, priority ?? null, weight ?? null, port ?? null, proxied, cloudflareId],
    );

    reply.code(201);
    return { record: rows[0], cloudflareStatus };
  });

  fastify.put("/api/domains/:id/dns/:recordId", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const recordId = parseIdParam((request.params as { recordId: string }).recordId);
    if (recordId === null) {
      reply.code(400);
      return { error: "Geçersiz kayıt id." };
    }
    const parsed = updateDnsRecordInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }

    const existing = await fastify.pg.query(
      `SELECT id, cloudflare_id, record_type, name, content, ttl, priority, weight, port, proxied
         FROM dns_records WHERE id = $1 AND domain_id = $2`,
      [recordId, resolved.domain.id],
    );
    if (existing.rows.length === 0) {
      reply.code(404);
      return { error: "DNS kaydı bulunamadı." };
    }
    const current = existing.rows[0];
    // DB'den priority/weight/port NULL döner ama zod şeması bu alanları
    // `.optional()` (undefined) olarak tanımlıyor — NULL geçilirse
    // "Expected number, received null" ile reddedilir. Yeniden doğrulamadan
    // önce null'ları undefined'a çeviriyoruz.
    const merged = {
      ...current,
      priority: current.priority ?? undefined,
      weight: current.weight ?? undefined,
      port: current.port ?? undefined,
      ...parsed.data,
    };

    // updateDnsRecordInputSchema tipe göre zorunluluk kontrolü YAPMAZ (bkz.
    // packages/shared) — merge sonucu burada create şemasıyla yeniden
    // doğrulanır, böylece "MX iken priority silinir" gibi tutarsız bir
    // sonuç veritabanına/Cloudflare'e yazılamaz.
    const revalidated = createDnsRecordInputSchema.safeParse(merged);
    if (!revalidated.success) {
      reply.code(400);
      return { error: "Güncelleme sonucu geçersiz kayıt oluşturur", issues: revalidated.error.issues };
    }
    const next = revalidated.data;

    const client = getCloudflareClient();
    let cloudflareStatus: "not_configured" | "not_synced" | "synced" = "not_synced";
    try {
      if (client.isConfigured && current.cloudflare_id) {
        const { zone } = await resolveZoneForDomain(client, resolved.domain.domain_name);
        if (zone) {
          await client.updateDnsRecord(
            zone.id,
            current.cloudflare_id,
            toCloudflarePayload({
              record_type: next.record_type,
              name: next.name,
              content: next.content,
              ttl: next.ttl,
              proxied: next.proxied,
              priority: next.priority ?? null,
              weight: next.weight ?? null,
              port: next.port ?? null,
            }),
          );
          cloudflareStatus = "synced";
        }
      } else if (!client.isConfigured) {
        cloudflareStatus = "not_configured";
      }
    } catch (err) {
      if (err instanceof CloudflareError) {
        reply.code(502);
        return { error: `Cloudflare'de güncellenemedi: ${err.message}` };
      }
      throw err;
    }

    const { rows } = await fastify.pg.query(
      `UPDATE dns_records SET record_type=$1, name=$2, content=$3, ttl=$4, priority=$5, weight=$6, port=$7, proxied=$8, synced_at=NOW()
       WHERE id=$9 RETURNING id, domain_id, record_type, name, content, ttl, priority, weight, port, proxied, cloudflare_id, synced_at`,
      [next.record_type, next.name, next.content, next.ttl, next.priority ?? null, next.weight ?? null, next.port ?? null, next.proxied, recordId],
    );
    return { record: rows[0], cloudflareStatus };
  });

  fastify.delete("/api/domains/:id/dns/:recordId", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const recordId = parseIdParam((request.params as { recordId: string }).recordId);
    if (recordId === null) {
      reply.code(400);
      return { error: "Geçersiz kayıt id." };
    }
    const existing = await fastify.pg.query(
      `SELECT id FROM dns_records WHERE id = $1 AND domain_id = $2`,
      [recordId, resolved.domain.id],
    );
    if (existing.rows.length === 0) {
      reply.code(404);
      return { error: "DNS kaydı bulunamadı." };
    }

    // BİLİNÇLİ TASARIM: silme SADECE panelin yerel dns_records tablosunu
    // etkiler, Cloudflare'deki gerçek kayda DOKUNMAZ — kayıt cloudflare_id
    // taşısa (yani daha önce Cloudflare'den çekilmiş olsa) bile. Panelden
    // silmek istemeden gerçek prod DNS'i kırmasın diye kasıtlı olarak
    // ayrıştırıldı; Cloudflare'de gerçekten silmek isteyen admin bunu
    // doğrudan Cloudflare'de yapar. "Cloudflare'e Gönder" (push) tek yönlü
    // kalır: yerel → Cloudflare, asla Cloudflare → yerel silme tetiklemez.
    await fastify.pg.query(`DELETE FROM dns_records WHERE id = $1`, [recordId]);
    return { ok: true };
  });

  // Cloudflare kullanmaktan tamamen vazgeçen bir domain için TÜM yerel DNS
  // kayıtlarını tek seferde temizler — tekil silme route'uyla AYNI kural:
  // SADECE dns_records tablosunu etkiler, Cloudflare'deki hiçbir kayda
  // dokunmaz. "Tümünü Cloudflare'e Gönder"in tam tersi yönde ama aynı
  // felsefede tek yönlü bir operasyon (yerel → hiçbir yere).
  fastify.delete("/api/domains/:id/dns", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    const result = await fastify.pg.query(`DELETE FROM dns_records WHERE domain_id = $1`, [resolved.domain.id]);
    return { ok: true, deletedCount: result.rowCount ?? 0 };
  });

  // Yerelde cloudflare_id IS NULL olan (domain oluşturulunca otomatik
  // önerilen ama henüz gerçek Cloudflare'e gönderilmemiş) kayıtları toplu
  // gönderir. Bilinçli olarak admin'in TETİKLEDİĞİ ayrı bir aksiyon —
  // guard.json'daki "Cloudflare DNS kaydı ekleme" onay şartına uygun, domain
  // oluşturma sırasında OTOMATİK çağrılmaz. Kısmi başarıyı destekler: bir
  // kayıt başarısız olsa da diğerleri denenmeye devam eder.
  fastify.post("/api/domains/:id/dns/push-to-cloudflare", { preHandler: fastify.requireAdmin }, async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    return pushDomainDnsToCloudflare(fastify.pg, getCloudflareClient(), resolved.domain.id, resolved.domain.domain_name);
  });

  // --- Sunucunun kendi (Cloudflare dışı) otoriter DNS'i — madde 5 ---
  fastify.get("/api/domains/:id/dns/local-status", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    return {
      zone_generated: isZoneGenerated(resolved.domain.domain_name),
      zone_deployed: isZoneDeployed(resolved.domain.domain_name),
      // Tanımlıysa "bu sunucuya yönlendir" tek-tık A kaydı butonu için.
      server_ip: env.SERVER_PUBLIC_IP ?? null,
    };
  });

  fastify.post("/api/domains/:id/dns/local-apply", async (request, reply) => {
    const resolved = await requireOwnedDomain(request);
    if (resolved.error) {
      reply.code(resolved.error.status);
      return resolved.error.body;
    }
    return applyDomainLocalDns(fastify.pg, resolved.domain.id, resolved.domain.domain_name);
  });
};

export default dnsRoutes;
