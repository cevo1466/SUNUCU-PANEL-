import { env } from "../env.js";

// Cloudflare API v4 istemcisi. AGENTS.md § Modül 2: "Cloudflare API'si ile
// çift yönlü entegre çalışarak panelde yapılan her değişikliği Cloudflare
// üzerinde otomatik güncelleyen ve Cloudflare'deki güncel durumları panel
// veri tabanına çeken bir cron/job mekanizması."
//
// ⚠️ Bu koddaki create/update/delete metodları GERÇEK, üretime hazır
// Cloudflare çağrıları yapar. Bu sandbox'ta KASITLI olarak gerçek hesaba
// karşı hiç ÇAĞRILMADI (bkz. lib/cloudflare.self-test.ts — sadece yerel
// mock HTTP sunucusuna karşı test edildi). Gerçek hesaba karşı SADECE
// salt-okunur `listZones`/`listDnsRecords` çağrıldı (bkz. MEMORY.md Oturum 5).

export class CloudflareError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors: Array<{ code: number; message: string }> = [],
  ) {
    super(message);
  }
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

export interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
}

export interface DnsRecordInput {
  type: string;
  name: string;
  // SRV kayıtlarında content YOK, yerine aşağıdaki "data" kullanılır.
  content?: string;
  ttl?: number;
  proxied?: boolean;
  // MX: Cloudflare üst düzey "priority" alanı bekler (content sadece hedef).
  priority?: number;
  // SRV: Cloudflare "content" değil "data" objesi bekler; "name" burada
  // "_service._proto.name" formunda gönderilir (zaten çağıran taraf hesaplar).
  data?: {
    service?: string;
    proto?: string;
    name?: string;
    priority: number;
    weight: number;
    port: number;
    target: string;
  };
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
}

export interface CloudflareClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class CloudflareClient {
  private apiToken?: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: CloudflareClientOptions = {}) {
    this.apiToken = opts.apiToken ?? env.CLOUDFLARE_API_TOKEN;
    this.baseUrl = opts.baseUrl ?? env.CLOUDFLARE_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiToken);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.apiToken) {
      throw new CloudflareError("Cloudflare API token yapılandırılmadı.", 0);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({ success: false, result: null, errors: [] }))) as CloudflareEnvelope<T>;
    if (!res.ok || !body.success) {
      const message = body.errors?.map((e) => e.message).join("; ") || `Cloudflare API hatası (HTTP ${res.status})`;
      throw new CloudflareError(message, res.status, body.errors ?? []);
    }
    return body.result;
  }

  listZones(name?: string): Promise<CloudflareZone[]> {
    const qs = name ? `?name=${encodeURIComponent(name)}` : "?per_page=50";
    return this.request<CloudflareZone[]>(`/zones${qs}`);
  }

  listDnsRecords(zoneId: string): Promise<CloudflareDnsRecord[]> {
    return this.request<CloudflareDnsRecord[]>(`/zones/${zoneId}/dns_records?per_page=100`);
  }

  createDnsRecord(zoneId: string, record: DnsRecordInput): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(record),
    });
  }

  updateDnsRecord(
    zoneId: string,
    recordId: string,
    record: Partial<DnsRecordInput>,
  ): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "PUT",
      body: JSON.stringify(record),
    });
  }

  deleteDnsRecord(zoneId: string, recordId: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
    });
  }
}

let sharedClient: CloudflareClient | undefined;
export function getCloudflareClient(): CloudflareClient {
  if (!sharedClient) sharedClient = new CloudflareClient();
  return sharedClient;
}

/**
 * Paylaşılan istemciyi düşürür; bir sonraki çağrı env'i yeniden okur.
 * Token değiştirildiğinde ve testlerde Cloudflare'i taklit ederken gerekli.
 */
export function resetCloudflareClient(): void {
  sharedClient = undefined;
}
