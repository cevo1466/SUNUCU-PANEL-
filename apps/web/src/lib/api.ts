// apps/api ile tek temas noktası. Tarayıcıda çalışır (credentials:'include'
// ile cookie tabanlı oturum apps/api'ye taşınır — CORS origin izinli listede).
// Tarayıcı her zaman panelin kendi origin'ine konuşur. Next.js `/api/*`
// isteklerini sunucu tarafında Fastify'a aktarır (next.config.ts). Böylece
// public erişimde 3001 portunu açmak veya kullanıcının bilgisayarındaki
// `localhost`a yanlışlıkla istek göndermek gerekmez.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

/** Tek bir domain dizininin diskte kapladığı alan. */
export interface DomainDiskUsage {
  id: number;
  domain_name: string;
  /** Diskte kaplanan bayt. Ölçülemediyse null (o zaman `error` doludur). */
  bytes: number | null;
  /** Dizin henüz yoksa true; bytes 0 gelir. */
  missing: boolean;
  measured_at: string;
  error?: string;
}

export interface DiskUsageResponse {
  items: DomainDiskUsage[];
  /** Yalnızca ÖLÇÜLEBİLENLERİN toplamı. */
  total_bytes: number;
  measured_count: number;
  total_count: number;
}

export interface BackupVersion {
  name: string;
  size_bytes: number;
  created_at: string;
  file_count: number | null;
  databases: Array<{ engine: string; name: string }>;
  /** Beklenen her parca alindi mi. null = bilinmiyor (eski kayit). */
  complete: boolean | null;
  warnings: string[];
  /** null = HIC dogrulanmadi. "ok" = geri yuklenebildigi KANITLANDI. */
  verify_status: "ok" | "failed" | null;
  verified_at: string | null;
  verify_error: string | null;
}

export interface BackupListResponse {
  retention: number;
  backups: BackupVersion[];
}

export interface BackupSchedule {
  enabled: boolean;
  backup_utc: string;
  verify_utc: string;
}

export interface BackupCreated {
  name: string;
  size_bytes: number;
  created_at: string;
  complete: boolean;
  warnings: string[];
  databases: Array<{ engine: string; name: string }>;
  rotated_out: string[];
}

export interface BackupVerifyResult {
  name: string;
  ok: boolean;
  error?: string;
  detail: {
    archive_readable: boolean;
    manifest_found: boolean;
    parts_checked: number;
    parts_failed: string[];
    file_count_expected: number | null;
    file_count_actual: number | null;
    databases_loaded: string[];
    databases_failed: Array<{ name: string; error: string }>;
  };
}

export interface RestorePlan {
  domain_name: string;
  archive: string;
  created_at: string;
  target_dir: string;
  file_count: number;
  databases: Array<{ engine: string; name: string }>;
  parts: Array<{ path: string; note: string }>;
  warnings: string[];
  current_file_count: number | null;
}

/** Yuklenecek tek dosya + hedef klasore gore goreli yolu (klasor yuklemesi). */
export interface UploadItem {
  file: File;
  /** Örn. "dist/assets/app.js" — düz dosyada sadece dosya adı. */
  relPath: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Content-Type YALNIZCA gerçekten gövde varken gönderilir. Başlığı gövdesiz
  // bir isteğe koymak Fastify'ı FST_ERR_CTP_EMPTY_JSON_BODY ile 400'e düşürür;
  // silme, yedek alma, config üretme gibi gövdesiz yedi uç bu yüzden çalışmıyordu.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined && init.body !== null) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const rawBody = await res.text();
  let body: unknown = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = { raw: rawBody.slice(0, 500) };
    }
  }
  if (!res.ok) {
    const upstreamMessage =
      res.status >= 500
        ? `Panel API servisi geçici olarak kullanılamıyor (${res.status}). Servis durumu otomatik izleniyor.`
        : undefined;
    throw new ApiError(
      (body as { error?: string }).error ?? upstreamMessage ?? `İstek başarısız (${res.status})`,
      res.status,
      body,
    );
  }
  return body as T;
}

export interface CurrentUser {
  id: number;
  username: string;
  email: string;
  role: "admin" | "customer";
}

export type DnsProvider = "local" | "cloudflare" | "none";

export interface Domain {
  id: number;
  domain_name: string;
  directory_path: string;
  ssl_status: boolean;
  ssl_expiry: string | null;
  dns_provider: DnsProvider;
  created_at: string;
  directory_exists: boolean;
  config_generated: boolean;
  nginx_deployed: boolean;
  has_customer_account: boolean;
  customer_email: string | null;
  runtime_type: "static" | "php" | "proxy";
  php_version: string | null;
  proxy_port: number | null;
}

export interface DomainRuntime {
  runtime_type: "static" | "php" | "proxy";
  php_version: string | null;
  proxy_port: number | null;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
}

export interface BackupInfo {
  exists: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
  path?: string;
}

export interface DnsRecord {
  id: number;
  domain_id: number;
  record_type: "A" | "CNAME" | "TXT" | "MX" | "SRV";
  name: string;
  content: string;
  ttl: number;
  priority: number | null;
  weight: number | null;
  port: number | null;
  proxied: boolean;
  cloudflare_id: string | null;
  synced_at: string;
}

export type CloudflareStatus =
  | { status: "not_configured" }
  | { status: "zone_not_found"; domain: string }
  /** `permission` = token'a yetki eklenmeli, `upstream` = Cloudflare tarafı arızalı. */
  | { status: "error"; message: string; httpStatus?: number; reason?: "permission" | "upstream" }
  | { status: "ok"; zone: { id: string; name: string; status: string }; liveRecordCount: number };

export interface SslInfo {
  id: number;
  domain_name: string;
  ssl_status: boolean;
  ssl_expiry: string | null;
  /** nginx'in sundugu sertifika: certbot (letsencrypt) veya panelden yuklenen ucretli CA (custom). */
  ssl_type?: "letsencrypt" | "custom";
  ssl_issuer?: string | null;
}

/** Sertifikanin acik alanlari (ozel anahtar ASLA donmez). */
export interface SslCertDetails {
  present: boolean;
  type?: "letsencrypt" | "custom";
  subject?: string;
  issuer?: string;
  serial?: string;
  notBefore?: string | null;
  notAfter?: string | null;
  fingerprint?: string;
  sans: string[];
  keyAlgo?: string;
  keyBits?: number | null;
  chainLength?: number;
  /** CSR uretildi, CA'dan gelen sertifika henuz yuklenmedi. */
  pendingCsr: boolean;
}

export interface SslCsrInput {
  commonName: string;
  sans: string[];
  organization: string;
  unit: string;
  country: string;
  state: string;
  city: string;
  email: string;
  keyType: "rsa2048" | "rsa4096" | "ec256";
}

export interface FtpAccount {
  id: number;
  domain_id: number;
  username: string;
  home_dir: string;
  quota_mb: number | null;
  enabled: boolean;
  created_at: string;
}

export interface FtpServiceStatus {
  installed: boolean;
  running: boolean;
  note: string;
}

export type DbEngine = "postgres" | "mysql";

/** Motorun GERÇEK durumu. `available:false` ise sunucu yok/yanıt vermiyor. */
export interface DbEngineStatus {
  engine: DbEngine;
  /** Gerçek sunucu etiketi ("MySQL"/"MariaDB"/"PostgreSQL"); tespit edilemediyse null. */
  label: string | null;
  available: boolean;
  host: string;
  port: number;
  note: string;
}

export interface DbConnection {
  host: string;
  port: number;
}

export interface PanelDatabase {
  id: number;
  domain_id: number;
  engine: DbEngine;
  db_name: string;
  db_user: string;
  created_at: string;
}

export const DB_ENGINE_LABEL: Record<DbEngine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
};

export interface ResourceMetrics {
  memory: { limitBytes: number | null; usedBytes: number };
  cpu: {
    quotaMicros: number | null;
    periodMicros: number | null;
    throttledUsec: number | null;
    usageUsec: number | null;
    /** Konteyner açılışından beri KÜMÜLATİF. Tek başına gösterilmez. */
    nrThrottled: number | null;
    nrPeriods: number | null;
    /** Son örnekleme penceresine ait fark. İlk okumada null. */
    throttledPeriodsDelta: number | null;
    periodsDelta: number | null;
    /** Anlık kullanım yüzdesi. İlk örnekte referans olmadığı için null olabilir. */
    usagePercent: number | null;
    vcpus: number | null;
  };
  disk: { path: string; totalBytes: number; usedBytes: number; availableBytes: number };
  sampledAt: string;
}

export type MetricsRange = "5m" | "30m" | "1h";

export interface MetricsSample {
  /** Unix epoch milisaniye. */
  t: number;
  cpuPercent: number | null;
  memPercent: number | null;
  memUsedBytes: number;
  /** Bu örneğin kendi aralığındaki throttle sayıları. Kümülatif DEĞİL. */
  throttledPeriods: number | null;
  periods: number | null;
}

export interface MetricsHistory {
  samples: MetricsSample[];
  intervalMs: number;
  capacity: number;
  range: MetricsRange;
}

export interface MailAccount {
  id: number;
  domain_id: number;
  local_part: string;
  address: string;
  maildir: string;
  quota_mb: number | null;
  enabled: boolean;
  created_at: string;
  /** Posta kutusunun diskte kapladığı alan. null = ÖLÇÜLEMEDİ (0 değil). */
  used_bytes: number | null;
  usage_error: string | null;
}

export interface ServerHealth {
  services: Array<{
    name: string;
    label: string;
    port: number;
    host: string;
    running: boolean;
    role: string;
  }>;
  certificates: Array<{
    name: string;
    domains: string[];
    expiresAt: string;
    daysLeft: number;
  }>;
  certificateError?: string;
  jobs: Array<{
    label: string;
    schedule: string;
    command: string;
    /** "Son çalışma" DEĞİL "son çıktı" — sessiz işler müdahale etmedikçe yazmaz. */
    lastOutputAt: string | null;
    quiet: boolean;
    enabled: boolean;
  }>;
  jobsError?: string;
}

export interface MailPort {
  label: string;
  port: number;
  open: boolean;
}

export interface MailServiceStatus {
  postfixInstalled: boolean;
  dovecotInstalled: boolean;
  installed: boolean;
  running: boolean;
  ports: MailPort[];
  usersFile: string;
  note: string;
}

export interface MailListResult {
  accounts: MailAccount[];
  suggestedLocalPart: string;
  defaultQuotaMb: number | null;
  /** Sunucu kotayi bu kullaniciya acik mi diyor — UI bunu gorunume yansitir. */
  canSetQuota: boolean;
  service: MailServiceStatus;
  /**
   * Bu domainin webmail adresi. `https` alanı, o ad için sertifikanın
   * GERÇEKTEN yayında olup olmadığını söyler — url'in şeması buna göre
   * seçilir, kullanıcı sertifika uyarısına gönderilmez.
   */
  webmail: { url: string; https: boolean };
  /**
   * Posta DNS kayıtlarının GERÇEK durumu — panelin kaydına değil DNS'e
   * bakılarak ölçülür. Eksik kayıt varsa posta ya hiç gelmez (MX) ya da
   * "gönderen doğrulanamadı" damgası yer (SPF/DKIM/DMARC).
   */
  dns: {
    entries: Array<{
      kind: "mail-a" | "mx" | "spf" | "dkim" | "dmarc";
      label: string;
      host: string;
      state: "var" | "eksik" | "bakilamadi";
      found?: string;
      error?: string;
    }>;
    complete: boolean;
    missing: number;
  };
}

export interface UptimeMonitor {
  id: string;
  name: string;
  target: string;
  uptime_status: string;
}

export type UptimeMetrics =
  | { status: "not_configured" }
  | { status: "error"; httpStatus: number; message: string }
  | { status: "ok"; monitors: UptimeMonitor[] };

export const api = {
  login: (input: { email: string; password: string }) =>
    request<{ user: CurrentUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: CurrentUser }>("/api/auth/me"),
  health: () => request<{ status: string; db: string }>("/api/health"),
  resourceMetrics: () => request<ResourceMetrics>("/api/metrics/resources"),
  metricsHistory: (range: MetricsRange) =>
    request<MetricsHistory>(`/api/metrics/history?range=${range}`),
  uptimeMetrics: () => request<UptimeMetrics>("/api/metrics/uptime"),
  listDomains: () => request<{ domains: Domain[] }>("/api/domains"),

  /**
   * Domain başına disk kullanımı — domain listesinden AYRI çağrılır.
   * Sunucuda `du` dizini gerçekten gezdiği için saniyeler sürebilir; liste
   * hızlı gelsin, kullanım sonradan dolsun diye ayrı uçta duruyor.
   * `refresh` önbelleği atlar.
   */
  domainsDiskUsage: (refresh = false) =>
    request<DiskUsageResponse>(`/api/domains/disk-usage${refresh ? "?refresh=1" : ""}`),
  createDomain: (input: { domain_name: string; dns_provider: DnsProvider }) =>
    request<{
      domain: Domain;
      dns_warnings: string[];
      dns_deployment: { status?: string; applied?: boolean; apply_error?: string } | null;
    }>("/api/domains", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteDomain: (id: number, confirm: string) =>
    request<{
      ok: boolean;
      cleanup_status: "completed" | "pending";
      directory_removal: "completed" | "pending";
      directory_path: string;
      domain_root_path: string;
      data_removal: "completed";
      note: string;
    }>(
      `/api/domains/${id}`,
      { method: "DELETE", body: JSON.stringify({ confirm }) },
    ),
  generateNginxConfig: (id: number) =>
    request<{
      ok: boolean;
      generated_path: string;
      nginx_deployed: boolean;
      applied: boolean;
      apply_error?: string;
      /** Sertifikasi olan domainlerde HTTPS blogu korunarak uretildi mi. */
      https: boolean;
      content: string;
    }>(`/api/domains/${id}/nginx-config`, { method: "POST" }),
  listFiles: (id: number, path: string) =>
    request<{ path: string; entries: FileEntry[] }>(
      `/api/domains/${id}/files?path=${encodeURIComponent(path)}`,
    ),
  downloadFileUrl: (id: number, path: string) =>
    `/api/domains/${id}/files/download?path=${encodeURIComponent(path)}`,
  readFile: (id: number, path: string) =>
    request<{ path: string; content: string }>(
      `/api/domains/${id}/files/read?path=${encodeURIComponent(path)}`,
    ),
  createFile: (id: number, path: string, isDirectory: boolean, content = "") =>
    request<{ ok: boolean }>(`/api/domains/${id}/files`, {
      method: "POST",
      body: JSON.stringify({ path, isDirectory, content }),
    }),
  updateFile: (id: number, path: string, content: string) =>
    request<{ ok: boolean }>(`/api/domains/${id}/files`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),
  deleteFile: (id: number, path: string) =>
    request<{ ok: boolean }>(`/api/domains/${id}/files?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  renameFile: (id: number, from: string, to: string) =>
    request<{ ok: boolean }>(`/api/domains/${id}/files/rename`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),
  /**
   * Klasör yapısını KORUYARAK yükler. Her dosya için göreli yolu (`relPath`)
   * dosyadan hemen önce ayrı bir alan olarak gönderilir — tarayıcının
   * FormData filename alanına `/` koymasına güvenmiyoruz. `count` alanı
   * sunucunun eksik alınan dosyayı fark etmesini sağlar.
   */
  /**
   * Dosya yükler ve YÜKLEME İLERLEMESİNİ bildirir.
   *
   * NEDEN fetch DEĞİL XMLHttpRequest: `fetch` istek GÖVDESİNİN gönderim
   * ilerlemesini vermez — yalnızca yanıt geldiğinde haber verir. (Streams
   * tabanlı bir çözüm var ama duplex istek gövdesi gerektiriyor ve
   * tarayıcılarda güvenilir değil.) XHR'ın `upload.onprogress` olayı 20 yıldır
   * her tarayıcıda çalışıyor ve tam olarak bu iş için var. Panelde 500 MB'lık
   * bir dosya yüklerken kullanıcının hiçbir geri bildirim görmemesinin sebebi
   * buydu.
   *
   * `signal` ile yükleme iptal edilebilir; XHR gerçekten `abort()` edilir,
   * yani bağlantı kapanır — sadece arayüzden vazgeçilmiş olmaz.
   */
  uploadFiles: (
    id: number,
    path: string,
    items: UploadItem[],
    options: {
      /** Gönderilen/toplam bayt. Tarayıcı sıkışırsa hiç çağrılmayabilir. */
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
    } = {},
  ) => {
    const form = new FormData();
    form.append("path", path);
    form.append("count", String(items.length));
    for (const item of items) {
      form.append("relpath", item.relPath);
      form.append("file", item.file, item.file.name);
    }

    return new Promise<{ ok: boolean; files: Array<{ name: string; size: number }> }>(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}/api/domains/${id}/files/upload`);
        xhr.withCredentials = true;

        if (options.onProgress) {
          xhr.upload.addEventListener("progress", (event) => {
            // lengthComputable, gövde boyutu bilinmiyorsa false olur; o
            // durumda yüzde hesaplanamaz, uydurmak yerine bildirmiyoruz.
            if (event.lengthComputable) options.onProgress!(event.loaded, event.total);
          });
        }

        function parseBody(): unknown {
          if (!xhr.responseText) return {};
          try {
            return JSON.parse(xhr.responseText);
          } catch {
            return { raw: xhr.responseText.slice(0, 500) };
          }
        }

        xhr.addEventListener("load", () => {
          const body = parseBody();
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(body as { ok: boolean; files: Array<{ name: string; size: number }> });
            return;
          }
          reject(
            new ApiError(
              (body as { error?: string }).error ?? `Yükleme başarısız (${xhr.status})`,
              xhr.status,
              body,
            ),
          );
        });

        // Ağ hatası: status 0'dır ve gövde yoktur. Genel "başarısız" demek
        // yerine sebebi söylüyoruz — bu uçta en sık görülen hata bu.
        xhr.addEventListener("error", () => {
          reject(new ApiError("Bağlantı koptu. Yükleme tamamlanamadı.", 0, {}));
        });
        xhr.addEventListener("timeout", () => {
          reject(new ApiError("Yükleme zaman aşımına uğradı.", 0, {}));
        });
        xhr.addEventListener("abort", () => {
          reject(new ApiError("Yükleme iptal edildi.", 0, { aborted: true }));
        });

        if (options.signal) {
          if (options.signal.aborted) {
            reject(new ApiError("Yükleme iptal edildi.", 0, { aborted: true }));
            return;
          }
          options.signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }

        xhr.send(form);
      },
    );
  },
  extractArchive: (id: number, path: string) =>
    request<{ ok: boolean; extracted: number }>(`/api/domains/${id}/files/extract`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  bulkDeleteFiles: (id: number, paths: string[]) =>
    request<{ ok: boolean; deleted: string[]; failed: Array<{ path: string; error: string }> }>(
      `/api/domains/${id}/files/bulk-delete`,
      { method: "POST", body: JSON.stringify({ paths }) },
    ),
  /**
   * Yedek surumlerini listeler.
   *
   * `verify_status` NULL ise yedek HIC DOGRULANMAMISTIR ve arayuz onu yesil
   * gostermez — denenmemis yedek, calisir yedek degildir.
   */
  listBackups: (id: number) => request<BackupListResponse>(`/api/domains/${id}/backups`),
  backupSchedule: () => request<BackupSchedule>("/api/backups/schedule"),
  setBackupSchedule: (enabled: boolean) => request<BackupSchedule>("/api/backups/schedule", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  }),
  createBackup: (id: number) => request<BackupCreated>(`/api/domains/${id}/backups`, { method: "POST" }),
  backupDownloadUrl: (id: number, name?: string) =>
    `${API_BASE}/api/domains/${id}/backups/download${name ? `?name=${encodeURIComponent(name)}` : ""}`,
  deleteBackup: (id: number, name: string) =>
    request<{ ok: boolean }>(`/api/domains/${id}/backups?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  verifyBackup: (id: number, name?: string) =>
    request<BackupVerifyResult>(`/api/domains/${id}/backups/verify`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    }),
  restorePlan: (id: number, name: string) =>
    request<RestorePlan>(`/api/domains/${id}/backups/restore-plan`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  restoreBackup: (id: number, name: string, confirmDomain: string, restoreDatabases: boolean) =>
    request<RestorePlan & { restored: true; quarantine_dir: string; databases_restored: string[]; databases_failed: Array<{ name: string; error: string }> }>(
      `/api/domains/${id}/backups/restore`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          confirm_domain: confirmDomain,
          restore_databases: restoreDatabases,
        }),
      },
    ),
  listDnsRecords: (id: number) => request<{ records: DnsRecord[] }>(`/api/domains/${id}/dns`),
  cloudflareStatus: (id: number) => request<CloudflareStatus>(`/api/domains/${id}/dns/cloudflare-status`),
  pullDnsFromCloudflare: (id: number) =>
    request<{ configured: boolean; zoneFound: boolean; zoneName?: string; pulled: number }>(
      `/api/domains/${id}/dns/pull`,
      { method: "POST" },
    ),
  createDnsRecord: (
    id: number,
    input: {
      record_type: string;
      name: string;
      content: string;
      ttl?: number;
      priority?: number;
      weight?: number;
      port?: number;
      proxied?: boolean;
    },
  ) =>
    request<{ record: DnsRecord; cloudflareStatus: string }>(`/api/domains/${id}/dns`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateDnsRecord: (
    id: number,
    recordId: number,
    input: {
      record_type?: string;
      name?: string;
      content?: string;
      ttl?: number;
      priority?: number;
      weight?: number;
      port?: number;
      proxied?: boolean;
    },
  ) =>
    request<{ record: DnsRecord; cloudflareStatus: string }>(
      `/api/domains/${id}/dns/${recordId}`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  deleteDnsRecord: (id: number, recordId: number) =>
    request<{ ok: boolean }>(`/api/domains/${id}/dns/${recordId}`, { method: "DELETE" }),
  deleteAllDnsRecords: (id: number) =>
    request<{ ok: boolean; deletedCount: number }>(`/api/domains/${id}/dns`, { method: "DELETE" }),
  pushDnsToCloudflare: (id: number) =>
    request<{
      status: "not_configured" | "zone_not_found" | "ok";
      zone?: { id: string; name: string };
      results: Array<{ id: number; ok: boolean; cloudflareId?: string; error?: string }>;
    }>(`/api/domains/${id}/dns/push-to-cloudflare`, { method: "POST" }),
  localDnsStatus: (id: number) =>
    request<{ zone_generated: boolean; zone_deployed: boolean; server_ip: string | null }>(
      `/api/domains/${id}/dns/local-status`,
    ),
  applyLocalDns: (id: number) =>
    request<{
      ok: boolean;
      generated_path: string;
      zone_deployed: boolean;
      applied: boolean;
      apply_error?: string;
      warnings: string[];
      content: string;
    }>(`/api/domains/${id}/dns/local-apply`, { method: "POST" }),
  sslStatus: (id: number) => request<{ ssl: SslInfo }>(`/api/domains/${id}/ssl`),
  /**
   * Certbot'u GERCEKTEN calistirir; donene kadar bekler (dakikaya varabilir).
   * Basarisizlikta ApiError.message, ssl-issue.sh'in yazdigi gercek sebeptir.
   */
  requestSsl: (id: number) =>
    request<{
      ok: boolean;
      status: "issued";
      ssl: SslInfo;
      /** Sertifika www.<domain> adını da kapsıyor mu. */
      www: boolean;
      /** webmail.<domain> sertifikasının sonucu. */
      webmail: "kuruldu" | "dns-yok" | "basarisiz" | "atlandi";
      /** SSL öncesi otomatik DNS hazırlığının sonucu (www ve webmail). */
      dns: Array<{
        host: string;
        outcome:
          | "zaten-var"
          | "olusturuldu"
          | "yayilmadi"
          | "cloudflare-yok"
          | "ip-yok"
          | "hata";
        detail?: string;
      }>;
      log: string;
    }>(`/api/domains/${id}/ssl/request`, { method: "POST" }),
  sslDetails: (id: number) => request<{ details: SslCertDetails }>(`/api/domains/${id}/ssl/details`),
  createSslCsr: (id: number, input: SslCsrInput) =>
    request<{ csr: string }>(`/api/domains/${id}/ssl/csr`, { method: "POST", body: JSON.stringify(input) }),
  pendingSslCsr: (id: number) => request<{ csr: string }>(`/api/domains/${id}/ssl/csr`),
  installCustomSsl: (id: number, input: { certificate: string; chain: string; privateKey: string }) =>
    request<{
      ok: boolean;
      ssl: SslInfo;
      www: boolean;
      chain: "ok" | "selfsigned";
      keySource: "csr" | "uploaded" | "current" | "";
    }>(`/api/domains/${id}/ssl/custom`, { method: "POST", body: JSON.stringify(input) }),
  removeCustomSsl: (id: number) =>
    request<{ ok: boolean; fallback: "letsencrypt" | "http"; ssl: SslInfo }>(
      `/api/domains/${id}/ssl/custom`,
      { method: "DELETE" },
    ),
  markSslIssued: (id: number, expiresAt: string) =>
    request<{ ssl: SslInfo }>(`/api/domains/${id}/ssl/mark-issued`, {
      method: "POST",
      body: JSON.stringify({ expiresAt }),
    }),
  /**
   * Disaridan SQL dokumu yukler. Dosya `fetch` ile dogrudan gonderilir —
   * `request()` JSON govde kuruyor, multipart burada elle yapiliyor.
   */
  importDatabase: async (
    id: number,
    dbId: number,
    file: File,
  ): Promise<{
    ok: boolean;
    engine: "postgres" | "mysql";
    database: string;
    bytes: number;
    gzipped: boolean;
    warnings: string[];
  }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/api/domains/${id}/databases/${dbId}/import`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    const raw = await res.text();
    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw: raw.slice(0, 500) };
      }
    }
    if (!res.ok) {
      throw new ApiError(
        (body as { error?: string }).error ?? `Yükleme başarısız (${res.status})`,
        res.status,
        body,
      );
    }
    return body as {
      ok: boolean;
      engine: "postgres" | "mysql";
      database: string;
      bytes: number;
      gzipped: boolean;
      warnings: string[];
    };
  },
  /** Sunucu sağlığı: servisler, sertifika envanteri, zamanlanmış işler. */
  serverHealth: () => request<ServerHealth>("/api/server/health"),
  listFtpAccounts: (id: number) =>
    request<{ accounts: FtpAccount[]; suggestedUsername: string; service: FtpServiceStatus }>(
      `/api/domains/${id}/ftp`,
    ),
  createFtpAccount: (
    id: number,
    input: { username: string; password?: string; quotaMb?: number | null },
  ) =>
    request<{ account: FtpAccount; password: string; service: FtpServiceStatus }>(
      `/api/domains/${id}/ftp`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  updateFtpAccount: (
    id: number,
    accountId: number,
    input: { password?: string; quotaMb?: number | null; enabled?: boolean },
  ) =>
    request<{ account: FtpAccount; password?: string }>(`/api/domains/${id}/ftp/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteFtpAccount: (id: number, accountId: number) =>
    request<{ ok: boolean }>(`/api/domains/${id}/ftp/${accountId}`, { method: "DELETE" }),
  listMailAccounts: (id: number) => request<MailListResult>(`/api/domains/${id}/mail`),
  /** Eksik posta DNS kayıtlarını gerçek sağlayıcıya yazar. */
  fixMailDns: (id: number) =>
    request<{
      ok: boolean;
      created: number;
      failed: Array<{ name: string; error: string }>;
      removed: string[];
      warnings: string[];
      unavailable?: string;
      dns: MailListResult["dns"];
    }>(`/api/domains/${id}/mail/dns`, { method: "POST" }),
  createMailAccount: (
    id: number,
    input: { localPart: string; password?: string; quotaMb?: number | null },
  ) =>
    request<{ account: MailAccount; password: string; service: MailServiceStatus }>(
      `/api/domains/${id}/mail`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  updateMailAccount: (
    id: number,
    accountId: number,
    input: { password?: string; enabled?: boolean },
  ) =>
    request<{ account: MailAccount; password?: string }>(`/api/domains/${id}/mail/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  setMailQuota: (id: number, accountId: number, quotaMb: number | null) =>
    request<{ account: MailAccount }>(`/api/domains/${id}/mail/${accountId}/quota`, {
      method: "PATCH",
      body: JSON.stringify({ quotaMb }),
    }),
  setMailQuotaDefault: (id: number, quotaMb: number | null) =>
    request<{ defaultQuotaMb: number | null }>(`/api/domains/${id}/mail/quota-default`, {
      method: "PUT",
      body: JSON.stringify({ quotaMb }),
    }),
  deleteMailAccount: (id: number, accountId: number) =>
    request<{ ok: boolean }>(`/api/domains/${id}/mail/${accountId}`, { method: "DELETE" }),
  databaseEngines: () => request<{ engines: DbEngineStatus[] }>("/api/databases/engines"),
  adminerStatus: () =>
    request<{
      installed: boolean;
      availablePhpBinaries: string[];
      selectedPhpBin: string | null;
      drivers: { postgres: boolean; mysql: boolean };
      note: string | null;
    }>("/api/adminer"),
  setAdminerPhpVersion: (phpBin: string) =>
    request<{ ok: boolean }>("/api/adminer/php-version", {
      method: "POST",
      body: JSON.stringify({ php_bin: phpBin }),
    }),
  listDatabases: (id: number) =>
    request<{
      databases: PanelDatabase[];
      suggestion: string;
      engines: DbEngineStatus[];
      adminerUrl: string | null;
    }>(`/api/domains/${id}/databases`),
  createDatabase: (
    id: number,
    input: { engine: DbEngine; dbName: string; dbUser: string; password?: string },
  ) =>
    request<{ database: PanelDatabase; password: string; connection: DbConnection }>(
      `/api/domains/${id}/databases`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  resetDatabasePassword: (id: number, dbId: number, password?: string) =>
    request<{ password: string; connection: DbConnection }>(
      `/api/domains/${id}/databases/${dbId}/password`,
      { method: "POST", body: JSON.stringify({ password }) },
    ),
  deleteDatabase: (id: number, dbId: number) =>
    request<{ ok: boolean }>(`/api/domains/${id}/databases/${dbId}`, { method: "DELETE" }),
  setCustomerAccount: (
    id: number,
    input: { username: string; email: string; password?: string },
  ) =>
    request<{ user: { id: number; username: string; email: string; role: "customer" }; password: string }>(
      `/api/domains/${id}/customer-account`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  removeCustomerAccount: (id: number) =>
    request<{ ok: boolean }>(`/api/domains/${id}/customer-account`, { method: "DELETE" }),
  getRuntime: (id: number) =>
    request<{ runtime: DomainRuntime; installedPhpVersions: string[] }>(`/api/domains/${id}/runtime`),
  setRuntime: (id: number, input: DomainRuntime) =>
    request<{ ok: boolean; runtime: DomainRuntime }>(`/api/domains/${id}/runtime`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
};
