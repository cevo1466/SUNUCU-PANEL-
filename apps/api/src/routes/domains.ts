import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDomainInputSchema, passwordField } from "@studio-panel/shared";
import {
  InvalidDomainError,
  createDomainDirectory,
  directoryExists,
  domainBackupPath,
  domainConfPath,
  domainRootPath,
  GENERATED_DIR,
  getOwnedDomain,
  isConfigGenerated,
  isNginxDeployed,
  parseIdParam,
  VHOSTS_ROOT,
} from "../lib/domain.js";
import { renderVhostConfig } from "../lib/nginxTemplate.js";
import { env, PROJECT_ROOT } from "../env.js";
import { applyPureFtpdReload, writePureFtpdPasswd } from "../lib/ftp.js";
import { applyMailReload, writeDovecotUsers } from "../lib/mail.js";
import { dropDatabasesForDomain, generateDbPassword } from "../lib/databases.js";
import { hashPassword } from "../lib/password.js";
import { generateDkimKeyPair } from "../lib/dkim.js";
import { applyDomainLocalDns, buildDefaultDnsRecords, pushDomainDnsToCloudflare } from "../lib/dnsProvision.js";
import { getCloudflareClient } from "../lib/cloudflare.js";
import { domainsDiskUsage } from "../lib/disk-usage.js";
import { initializeClaudeMemory } from "../lib/claude-mem.js";
import { initializeHeadroom } from "../lib/headroom-init.js";
import { z } from "zod";
import { invalidInput } from "../lib/validation.js";

const execFileAsync = promisify(execFile);
const DEPLOY_VHOST_SCRIPT = path.join(PROJECT_ROOT, "ops", "scripts", "deploy-vhost.sh");
const REMOVE_VHOST_SCRIPT = path.join(PROJECT_ROOT, "ops", "scripts", "remove-vhost.sh");

// sudoers'ta SADECE bu script'e, SADECE domain adı argümanıyla şifresiz
// çalışma izni tanımlanmalıdır (bkz. PROD-DEPLOYMENT.md). Script kendi içinde
// domain adını regex ile doğrular. Gerçek nginx bu container'da DEĞİL, ayrı
// bir Docker container'ında (`proxy-server`) çalışıyor — script config'i
// paylaşılan /etc/nginx/conf.d/'ye kopyaladıktan sonra `docker exec
// proxy-server nginx -t/-s reload` ile orada doğrulayıp devreye alır. Sudo
// yapılandırılı değilse veya docker'a erişim yoksa hata yakalanıp kullanıcıya
// "config üretildi ama uygulanamadı" olarak bildirilir.
async function applyNginxConfig(domainName: string): Promise<{ applied: boolean; error?: string }> {
  try {
    await execFileAsync("sudo", [DEPLOY_VHOST_SCRIPT, domainName], { timeout: 15_000 });
    return { applied: true };
  } catch (err) {
    const message =
      err && typeof err === "object" && "stderr" in err && (err as { stderr?: string }).stderr
        ? (err as { stderr: string }).stderr.trim()
        : (err as Error).message;
    return { applied: false, error: message };
  }
}

const PENDING_DELETIONS_LOG = path.join(GENERATED_DIR, "pending-directory-deletions.jsonl");

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function recordPendingCleanup(domainName: string, targets: string[], errors: string[]) {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.appendFile(
    PENDING_DELETIONS_LOG,
    JSON.stringify({
      domain_name: domainName,
      targets,
      errors,
      recorded_at: new Date().toISOString(),
    }) + "\n",
    "utf8",
  );
}

function serializeDomain(row: {
  id: number;
  domain_name: string;
  directory_path: string;
  ssl_status: boolean;
  ssl_expiry: Date | null;
  dns_provider: string;
  created_at: Date;
  owner_email?: string | null;
  owner_role?: "admin" | "customer" | null;
  runtime_type?: "static" | "php" | "proxy";
  php_version?: string | null;
  proxy_port?: number | null;
}) {
  return {
    ...row,
    directory_exists: directoryExists(row.directory_path),
    config_generated: isConfigGenerated(row.domain_name),
    nginx_deployed: isNginxDeployed(row.domain_name),
    // owner_role "customer" ise bu domain için ayrı bir müşteri girişi var —
    // domainTools/DomainCustomerAccess panelinin göstereceği durum.
    has_customer_account: row.owner_role === "customer",
    customer_email: row.owner_role === "customer" ? row.owner_email ?? null : null,
    runtime_type: row.runtime_type ?? "static",
    php_version: row.php_version ?? null,
    proxy_port: row.proxy_port ?? null,
  };
}

/**
 * Domain oluşturulduktan sonra öneri DNS kayıtlarını (A/CNAME/MX/SPF/DKIM/
 * DMARC/SRV) YEREL dns_records tablosuna cloudflare_id=NULL ile ekler.
 * Gerçek Cloudflare'e gönderim burada YAPILMAZ — guard.json'daki "Cloudflare
 * DNS kaydı ekleme/değişiklik/silme" onay şartı ve mevcut kod temkini
 * gereği bu, admin'in ayrı tetiklediği bir aksiyon (dns.ts push-to-cloudflare
 * route'u) olmalı. Hata durumunda domain oluşturmayı ENGELLEMEZ — sadece
 * warnings olarak döner (nginx config'in "üretildi ama uygulanamadı"
 * deseniyle aynı felsefe).
 */
async function provisionDefaultDns(
  pg: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  domainId: number,
  domainName: string,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  let dkimTxtValue = "";
  try {
    const dkim = await generateDkimKeyPair(domainName);
    dkimTxtValue = dkim.dnsTxtValue;
  } catch (err) {
    warnings.push(`DKIM anahtarı üretilemedi: ${(err as Error).message}`);
  }

  const { records, warnings: buildWarnings } = buildDefaultDnsRecords(domainName, {
    serverIp: env.SERVER_PUBLIC_IP ?? null,
    dkimTxtValue: dkimTxtValue || "v=DKIM1; k=rsa; p=",
  });
  warnings.push(...buildWarnings);

  try {
    for (const record of records) {
      await pg.query(
        `INSERT INTO dns_records (domain_id, record_type, name, content, ttl, priority, weight, port, proxied, cloudflare_id, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NULL, NOW())`,
        [
          domainId,
          record.record_type,
          record.name,
          record.content,
          record.ttl,
          record.priority ?? null,
          record.weight ?? null,
          record.port ?? null,
          record.proxied ?? false,
        ],
      );
    }
  } catch (err) {
    warnings.push(`Öneri DNS kayıtları yazılamadı: ${(err as Error).message}`);
  }

  return { warnings };
}

const domainsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/api/domains", async (request) => {
    // Admin devredilmiş (müşteri hesabına bağlı) domainler dahil HEPSİNİ
    // görür; müşteri yalnızca kendi user_id'sine bağlı domain(ler)i görür.
    const { rows } =
      request.currentUser!.role === "admin"
        ? await fastify.pg.query(
            `SELECT d.id, d.domain_name, d.directory_path, d.ssl_status, d.ssl_expiry, d.created_at,
                    d.runtime_type, d.php_version, d.proxy_port, d.dns_provider,
                    u.email AS owner_email, u.role AS owner_role
               FROM domains d JOIN users u ON u.id = d.user_id
               ORDER BY d.created_at DESC`,
          )
        : await fastify.pg.query(
            `SELECT id, domain_name, directory_path, ssl_status, ssl_expiry, created_at,
                    runtime_type, php_version, proxy_port, dns_provider
               FROM domains WHERE user_id = $1 ORDER BY created_at DESC`,
            [request.currentUser!.id],
          );
    return { domains: rows.map(serializeDomain) };
  });

  /**
   * Domain başına disk kullanımı.
   *
   * Yolu `/api/domains/:id`den ÖNCE tanımlı olmasına gerek yok — Fastify'ın
   * yönlendiricisinde sabit segment ("disk-usage") her zaman parametreli
   * segmentten (":id") önce gelir, çakışma olmaz.
   *
   * Kapsam `/api/domains` ile AYNI: admin hepsini, müşteri yalnızca kendi
   * domainlerini ölçer. Ölçüm yetkisi liste yetkisinden geniş olamaz, aksi
   * halde bir müşteri başka müşterinin disk kullanımını okuyabilirdi.
   *
   * `?refresh=1` önbelleği atlar (sayfadaki "Yenile" düğmesi bunu kullanır).
   */
  fastify.get("/api/domains/disk-usage", async (request) => {
    const { rows } =
      request.currentUser!.role === "admin"
        ? await fastify.pg.query<{ id: number; domain_name: string }>(
            `SELECT id, domain_name FROM domains ORDER BY domain_name`,
          )
        : await fastify.pg.query<{ id: number; domain_name: string }>(
            `SELECT id, domain_name FROM domains WHERE user_id = $1 ORDER BY domain_name`,
            [request.currentUser!.id],
          );

    const refresh = (request.query as { refresh?: string } | undefined)?.refresh === "1";
    const usage = await domainsDiskUsage(
      rows.map((row) => row.domain_name),
      { refresh },
    );

    // id'yi geri ekle: istemci domain adına göre değil id'ye göre eşleştirsin.
    const byName = new Map(usage.map((entry) => [entry.domain_name, entry]));
    const items = rows.map((row) => {
      const entry = byName.get(row.domain_name);
      return {
        id: row.id,
        domain_name: row.domain_name,
        bytes: entry?.bytes ?? null,
        missing: entry?.missing ?? false,
        measured_at: entry?.measured_at ?? new Date().toISOString(),
        ...(entry?.error ? { error: entry.error } : {}),
      };
    });

    // Toplam yalnızca ÖLÇÜLEBİLENLERİ kapsar; ölçülemeyen bir domain varsa
    // toplamı olduğundan küçük göstermemek için bu açıkça bildirilir.
    const measured = items.filter((item) => typeof item.bytes === "number");
    return {
      items,
      total_bytes: measured.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
      measured_count: measured.length,
      total_count: items.length,
    };
  });

  // Domain oluşturma/silme yalnızca admin'e açık — müşteri hesapları kendi
  // domainini yönetebilir ama yeni domain açamaz veya domain'i silemez.
  fastify.post("/api/domains", { preHandler: fastify.requireAdmin }, async (request, reply) => {
    const parsed = createDomainInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return invalidInput(parsed.error.issues);
    }
    const { domain_name, dns_provider } = parsed.data;

    let directoryPath: string;
    try {
      // Gerçek dizin oluşturma — devuser /var/www/vhosts'a sahip, izin var.
      // domainDirectoryPath içindeki hostname regex + kök-dışına-çıkma
      // kontrolü path-traversal'ı reddeder (bkz. lib/domain.ts).
      directoryPath = await createDomainDirectory(domain_name);
    } catch (err) {
      if (err instanceof InvalidDomainError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }

    try {
      const { rows } = await fastify.pg.query(
        `INSERT INTO domains (user_id, domain_name, directory_path, dns_provider)
         VALUES ($1, $2, $3, $4)
         RETURNING id, domain_name, directory_path, ssl_status, ssl_expiry, dns_provider, created_at`,
        [request.currentUser!.id, domain_name, directoryPath, dns_provider],
      );

      // Claude-mem hafıza dizinini otomatik oluştur
      const memoryInit = await initializeClaudeMemory(domain_name);

      // Headroom template'ini setup et
      const headroomInit = await initializeHeadroom(domain_name, directoryPath);

      const dnsResult = await provisionDefaultDns(fastify.pg, rows[0].id, domain_name);

      // Admin'in formda az önce seçtiği DNS otoritesine göre öneri
      // kayıtlarını OTOMATİK devreye alır — iki ayrı manuel buton (Cloudflare'e
      // Gönder / Zone oluştur ve uygula) yerine tek seçimle tamamlanır. Hata
      // olursa domain oluşturmayı ENGELLEMEZ, sonuç warnings/apply alanlarında
      // görünür (nginx config'teki "üretildi ama uygulanamadı" felsefesiyle aynı).
      let dnsDeployment: unknown = null;
      if (dns_provider === "cloudflare") {
        dnsDeployment = await pushDomainDnsToCloudflare(
          fastify.pg,
          getCloudflareClient(),
          rows[0].id,
          domain_name,
        );
      } else if (dns_provider === "local") {
        dnsDeployment = await applyDomainLocalDns(fastify.pg, rows[0].id, domain_name);
      }

      reply.code(201);
      return {
        domain: serializeDomain(rows[0]),
        dns_warnings: dnsResult.warnings,
        dns_deployment: dnsDeployment,
        claude_mem: { path: memoryInit.path, initialized: memoryInit.created },
        headroom: {
          initialized: headroomInit.initialized,
          path: headroomInit.details?.headroom_path ?? null,
          repo_cloned: headroomInit.details?.repo_cloned ?? false,
          error: headroomInit.error ?? null,
        },
      };
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        // unique_violation — dizini oluşturduk ama DB satırı zaten varmış.
        // Dizini geride bırakmak zararsız (bir sonraki denemede reuse edilir).
        reply.code(409);
        return { error: "Bu domain adı zaten kayıtlı." };
      }
      throw err;
    }
  });

  fastify.delete("/api/domains/:id", { preHandler: fastify.requireAdmin }, async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }

    const confirmation = (request.body as { confirm?: unknown } | undefined)?.confirm;
    if (typeof confirmation !== "string") {
      reply.code(400);
      return { error: "Silme işlemi için domain adını confirm alanında gönderin." };
    }
    const owned = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!owned) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }
    if (confirmation !== owned.domain_name) {
      reply.code(400);
      return { error: "Domain adı doğrulanmadı. Silme işlemi yapılmadı." };
    }

    // Gerçek veritabanları HER ŞEYDEN ÖNCE düşürülür.
    //
    // Neden burada: ON DELETE CASCADE yalnızca panel_databases SATIRINI siler;
    // PostgreSQL/MySQL sunucusundaki gerçek veritabanı ve rol öksüz kalırdı.
    // Neden dizin karantinasından önce: bu adım başarısız olursa henüz hiçbir
    // şey yok edilmemiş olur, silme işlemi hiç başlamadan durur.
    // Neden transaction dışında: CREATE/DROP DATABASE transaction içinde
    // çalışamaz.
    const dbFailures = await dropDatabasesForDomain(fastify.pg, id);
    if (dbFailures.length > 0) {
      reply.code(500);
      return {
        error: "Domaine bağlı veritabanları düşürülemedi, silme işlemi yapılmadı.",
        detail: dbFailures,
      };
    }

    const domainRoot = domainRootPath(owned.domain_name);
    const trashRoot = path.join(VHOSTS_ROOT.resolved, ".studio-panel-trash");
    const quarantinedRoot = path.join(
      trashRoot,
      `${owned.domain_name}-${crypto.randomUUID()}`,
    );
    let quarantined = false;
    const client = await fastify.pg.connect();

    try {
      // PostgreSQL rollback, fs.rm işlemini geri alamaz. Domain kökü bu yüzden
      // önce aynı filesystem içindeki karantinaya atomik taşınır; DB adımı
      // başarısız olursa eski yerine geri konabilir.
      if (await pathExists(domainRoot)) {
        await fs.mkdir(trashRoot, { recursive: true, mode: 0o700 });
        await fs.rename(domainRoot, quarantinedRoot);
        quarantined = true;
      }

      await client.query("BEGIN");
      // Silme, YETKILENDIRMEYLE AYNI KURALI kullanmak zorunda.
      //
      // BUG (2026-08-28'de e-posta self-test'i yakaladi): burada
      // `AND user_id = $2` vardi ve $2 admin'in kendi id'siydi. Rota zaten
      // `requireAdmin` ile korunuyor ve yukaridaki getOwnedDomain() admin
      // icin user_id filtresi UYGULAMIYOR — yani admin, bir MUSTERIYE
      // atanmis domaini silmeye yetkili sayiliyor ama DELETE hicbir satira
      // dokunmuyordu. Sonuc yalnizca "silinemedi" degildi:
      // dropDatabasesForDomain() bu noktadan ONCE ve transaction DISINDA
      // calisiyor, yani GERCEK VERITABANLARI ZATEN DUSURULMUS oluyordu;
      // ardindan transaction geri alinip kullaniciya yaniltici bir
      // "Domain bulunamadi." donuyordu. Domain duruyor, veritabanlari yok.
      // Musteri hesabi acilmis her domain bu durumdaydi.
      const { rows } = await client.query(
        `DELETE FROM domains WHERE id = $1 RETURNING domain_name, directory_path`,
        [id],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        if (quarantined) {
          await fs.rename(quarantinedRoot, domainRoot);
          quarantined = false;
        }
        reply.code(404);
        return { error: "Domain bulunamadı." };
      }

      // ON DELETE CASCADE FTP satırlarını da kaldırır; üretilen kaynak dosya
      // aynı transaction görünümünden yenilenmezse silinen hesap giriş yapmaya
      // devam ederdi.
      await writePureFtpdPasswd(client, env.VHOSTS_ROOT);
      // Ayni gerekce e-posta icin de gecerli: ON DELETE CASCADE yalnizca
      // mail_accounts SATIRLARINI siler; uretilen dosya bu transaction'in
      // gorunumunden yenilenmezse SILINEN DOMAIN'IN POSTA KUTUSU IMAP'e
      // giris yapmaya devam ederdi.
      await writeDovecotUsers(client, env.VHOSTS_ROOT);
      await client.query("COMMIT");
      await applyPureFtpdReload();
      await applyMailReload();

      const cleanupTargets = [
        ...(quarantined ? [quarantinedRoot] : []),
        domainBackupPath(rows[0].domain_name),
        domainConfPath(rows[0].domain_name),
      ];
      const cleanupResults = await Promise.allSettled(
        cleanupTargets.map((target) => fs.rm(target, { recursive: true, force: true })),
      );
      const cleanupErrors = cleanupResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${cleanupTargets[index]}: ${String(result.reason)}`]
          : [],
      );

      // Canlıya alınmış olabilecek /etc/nginx/conf.d/<domain>.conf, deploy-vhost.sh
      // gibi dar kapsamlı sudo kuralıyla (remove-vhost.sh) kaldırılır — reload
      // deploy-vhost.sh'te olduğu gibi burada da YAPILMAZ, operatör elle tetikler.
      try {
        await execFileAsync("sudo", [REMOVE_VHOST_SCRIPT, rows[0].domain_name], { timeout: 15_000 });
      } catch (err) {
        const message =
          err && typeof err === "object" && "stderr" in err && (err as { stderr?: string }).stderr
            ? (err as { stderr: string }).stderr.trim()
            : (err as Error).message;
        cleanupErrors.push(`/etc/nginx/conf.d/${rows[0].domain_name}.conf: ${message}`);
      }
      const cleanupStatus = cleanupErrors.length === 0 ? "completed" : "pending";
      if (cleanupErrors.length > 0) {
        await recordPendingCleanup(rows[0].domain_name, cleanupTargets, cleanupErrors);
        request.log.error({ cleanupErrors, domain: rows[0].domain_name }, "domain cleanup pending");
      }

      return {
        ok: true,
        cleanup_status: cleanupStatus,
        directory_removal: cleanupStatus,
        directory_path: rows[0].directory_path,
        domain_root_path: domainRoot,
        data_removal: "completed",
        note:
          cleanupStatus === "completed"
            ? "Domain, DNS/FTP kayıtları, tüm domain dizini, yedek ve üretilmiş Nginx config silindi."
            : "Domain kayıtları silindi; kalan dosya temizliği operatör kuyruğuna alındı.",
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (quarantined && (await pathExists(quarantinedRoot)) && !(await pathExists(domainRoot))) {
        await fs.rename(quarantinedRoot, domainRoot).catch((restoreError) => {
          request.log.fatal(
            { restoreError, domainRoot, quarantinedRoot },
            "domain quarantine restore failed",
          );
        });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  fastify.post("/api/domains/:id/nginx-config", async (request, reply) => {
    const id = parseIdParam((request.params as { id: string }).id);
    if (id === null) {
      reply.code(400);
      return { error: "Geçersiz domain id." };
    }

    const owned = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, request.currentUser!.role);
    if (!owned) {
      reply.code(404);
      return { error: "Domain bulunamadı." };
    }

    const { domain_name, directory_path } = owned;
    const { rows: runtimeRows } = await fastify.pg.query(
      "SELECT runtime_type, php_version, proxy_port FROM domains WHERE id = $1",
      [id],
    );
    const runtime = runtimeRows[0] as
      | { runtime_type: "static" | "php" | "proxy"; php_version: string | null; proxy_port: number | null }
      | undefined;
    // ops/generated/<domain>.conf'a yazar, ardından dar kapsamlı sudo kuralıyla
    // ops/scripts/deploy-vhost.sh'i çalıştırıp /etc/nginx/conf.d'ye uygulamayı
    // dener (nginx -t + reload script içinde). Sudo yapılandırılı değilse veya
    // script başarısız olursa `applied:false` + `apply_error` ile bildirilir;
    // config üretimi yine de tamamlanmış sayılır.
    const { path: confPath, content, https } = await renderVhostConfig(
      domain_name,
      directory_path,
      runtime ?? { runtime_type: "static", php_version: null, proxy_port: null },
    );
    const apply = await applyNginxConfig(domain_name);

    return {
      ok: true,
      generated_path: confPath,
      nginx_deployed: isNginxDeployed(domain_name),
      applied: apply.applied,
      apply_error: apply.error,
      // Sertifikasi olan domainlerde HTTPS blogu KORUNARAK uretildi. Bu alan
      // olmadan arayuz "config yenilendi" der ama HTTPS'in ayakta kalip
      // kalmadigini soyleyemezdi.
      https,
      content,
    };
  });

  // --- Domain başına müşteri girişi (madde 8) ---
  // Admin bu domain için ayrı, ana panelden bağımsız bir giriş açar/günceller.
  // Domain zaten bir müşteri hesabına bağlıysa o hesap güncellenir (yeni hesap
  // açılmaz) — aksi halde domain'in eski müşteri hesabı öksüz kalırdı.
  const customerAccountSchema = z.object({
    username: z.string().trim().min(3).max(100),
    email: z.string().trim().email().max(255),
    password: passwordField.optional(),
  });

  fastify.post(
    "/api/domains/:id/customer-account",
    { preHandler: fastify.requireAdmin },
    async (request, reply) => {
      const id = parseIdParam((request.params as { id: string }).id);
      if (id === null) {
        reply.code(400);
        return { error: "Geçersiz domain id." };
      }
      // Admin rolüyle çağrıldığı için domain'in kimin üstünde olduğuna
      // bakılmaksızın bulunur (bkz. getOwnedDomain role="admin" dalı).
      const domain = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, "admin");
      if (!domain) {
        reply.code(404);
        return { error: "Domain bulunamadı." };
      }

      const parsed = customerAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return invalidInput(parsed.error.issues);
      }
      const { username, email } = parsed.data;
      if (email === env.OWNER_EMAIL) {
        reply.code(400);
        return { error: "Bu e-posta yönetici hesabına ait, müşteri hesabında kullanılamaz." };
      }
      const password = parsed.data.password ?? generateDbPassword();
      const passwordHash = await hashPassword(password);

      const { rows: ownerRows } = await fastify.pg.query(
        "SELECT u.id, u.role FROM domains d JOIN users u ON u.id = d.user_id WHERE d.id = $1",
        [id],
      );
      const currentOwner = ownerRows[0] as { id: number; role: "admin" | "customer" } | undefined;

      try {
        if (currentOwner && currentOwner.role === "customer") {
          // Domain zaten bir müşteri hesabına bağlı — o hesabı güncelle.
          const conflict = await fastify.pg.query(
            "SELECT id FROM users WHERE (email = $1 OR username = $2) AND id <> $3",
            [email, username, currentOwner.id],
          );
          if (conflict.rows.length > 0) {
            reply.code(409);
            return { error: "Bu e-posta veya kullanıcı adı başka bir hesapta kullanılıyor." };
          }
          await fastify.pg.query(
            "UPDATE users SET username = $1, email = $2, password_hash = $3 WHERE id = $4",
            [username, email, passwordHash, currentOwner.id],
          );
          reply.code(200);
          return { user: { id: currentOwner.id, username, email, role: "customer" }, password };
        }

        const conflict = await fastify.pg.query(
          "SELECT id FROM users WHERE email = $1 OR username = $2",
          [email, username],
        );
        if (conflict.rows.length > 0) {
          reply.code(409);
          return { error: "Bu e-posta veya kullanıcı adı zaten kayıtlı." };
        }
        const { rows: created } = await fastify.pg.query(
          "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, 'customer') RETURNING id",
          [username, email, passwordHash],
        );
        const customerId = created[0].id as number;
        await fastify.pg.query("UPDATE domains SET user_id = $1 WHERE id = $2", [customerId, id]);
        reply.code(201);
        return { user: { id: customerId, username, email, role: "customer" }, password };
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          reply.code(409);
          return { error: "Bu e-posta veya kullanıcı adı zaten kayıtlı." };
        }
        throw err;
      }
    },
  );

  fastify.delete(
    "/api/domains/:id/customer-account",
    { preHandler: fastify.requireAdmin },
    async (request, reply) => {
      const id = parseIdParam((request.params as { id: string }).id);
      if (id === null) {
        reply.code(400);
        return { error: "Geçersiz domain id." };
      }
      const domain = await getOwnedDomain(fastify.pg, id, request.currentUser!.id, "admin");
      if (!domain) {
        reply.code(404);
        return { error: "Domain bulunamadı." };
      }
      const { rows: ownerRows } = await fastify.pg.query(
        "SELECT u.id, u.role FROM domains d JOIN users u ON u.id = d.user_id WHERE d.id = $1",
        [id],
      );
      const currentOwner = ownerRows[0] as { id: number; role: "admin" | "customer" } | undefined;
      if (!currentOwner || currentOwner.role !== "customer") {
        reply.code(404);
        return { error: "Bu domain için tanımlı bir müşteri hesabı yok." };
      }
      // Domain'i çağıran admin'e geri devret, sonra müşteri hesabını sil —
      // sıra önemli: FK NOT NULL değilse bile öksüz user_id bırakmıyoruz.
      await fastify.pg.query("UPDATE domains SET user_id = $1 WHERE id = $2", [
        request.currentUser!.id,
        id,
      ]);
      await fastify.pg.query("DELETE FROM sessions WHERE user_id = $1", [currentOwner.id]);
      await fastify.pg.query("DELETE FROM users WHERE id = $1", [currentOwner.id]);
      return { ok: true };
    },
  );
};

export default domainsRoutes;
