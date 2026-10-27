import { z } from "zod";

// Verilen PostgreSQL şemasıyla birebir eşleşir (AGENTS.md § 4).

export const userSchema = z.object({
  id: z.number().int(),
  username: z.string().min(3).max(100),
  email: z.string().email().max(255),
  created_at: z.coerce.date(),
});
export type User = z.infer<typeof userSchema>;

export const registerInputSchema = z.object({
  username: z.string().min(3).max(100),
  email: z.string().email().max(255),
  password: z.string().min(10).max(256),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

/**
 * Domain oluşturulurken DNS'in kimin elinde olacağı — admin'e SORULUR
 * (formda zorunlu alan), sessizce "none" varsayılmaz. "local" = bu
 * sunucunun kendi BIND9'u, "cloudflare" = gerçek Cloudflare hesabı,
 * "none" = şimdilik hiçbiri, kayıtlar yerelde bekler (admin sonra elle
 * karar verir). Seçime göre routes/domains.ts oluşturma anında otomatik
 * push/apply tetikler.
 */
export const dnsProviderSchema = z.enum(["local", "cloudflare", "none"]);
export type DnsProvider = z.infer<typeof dnsProviderSchema>;

export const domainSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  domain_name: z.string().max(255),
  directory_path: z.string().max(512),
  ssl_status: z.boolean(),
  ssl_expiry: z.coerce.date().nullable(),
  dns_provider: dnsProviderSchema,
  created_at: z.coerce.date(),
});
export type Domain = z.infer<typeof domainSchema>;

export const createDomainInputSchema = z.object({
  domain_name: z.string().min(1).max(255),
  // Panel UI'si bunu HER ZAMAN açıkça gönderir (kullanıcıya sorulur — bkz.
  // apps/web/domains sayfası); varsayılan sadece programatik çağrılar
  // (self-test, gelecekteki API entegrasyonları) için geriye dönük uyumluluk.
  dns_provider: dnsProviderSchema.default("none"),
});
export type CreateDomainInput = z.infer<typeof createDomainInputSchema>;

export const dnsRecordTypeSchema = z.enum(["A", "CNAME", "TXT", "MX", "SRV"]);
export type DnsRecordType = z.infer<typeof dnsRecordTypeSchema>;

export const dnsRecordSchema = z.object({
  id: z.number().int(),
  domain_id: z.number().int(),
  record_type: dnsRecordTypeSchema,
  name: z.string().max(255),
  content: z.string(),
  ttl: z.number().int().default(3600),
  // MX: priority zorunlu. SRV: priority/weight/port zorunlu. A/CNAME/TXT: üçü de null.
  priority: z.number().int().nullable(),
  weight: z.number().int().nullable(),
  port: z.number().int().nullable(),
  // Cloudflare proxy (turuncu bulut) — yalnizca A/CNAME icin anlamli.
  // Mail hedefleri (mail./webmail. A kayitlari, MX) ASLA proxied:true
  // uretilmez (bkz. lib/dnsProvision.ts) — SMTP/IMAP/POP3 Cloudflare
  // proxy'sinden gecmez.
  proxied: z.boolean(),
  cloudflare_id: z.string().max(255).nullable(),
  synced_at: z.coerce.date(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

const createDnsRecordBaseSchema = z.object({
  record_type: dnsRecordTypeSchema,
  name: z.string().min(1).max(255),
  content: z.string().min(1),
  ttl: z.number().int().min(60).max(86400).optional().default(3600),
  proxied: z.boolean().optional().default(false),
  priority: z.number().int().min(0).max(65535).optional(),
  weight: z.number().int().min(0).max(65535).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

// MX/SRV kayıtları Cloudflare'e priority/weight/port olmadan gönderilirse
// ya reddedilir ya da anlamsız bir varsayılana düşer — bu yüzden tipe göre
// zorunluluk burada, girdi sınırında uygulanıyor.
export const createDnsRecordInputSchema = createDnsRecordBaseSchema.superRefine((data, ctx) => {
  if (data.record_type === "MX" && data.priority === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["priority"], message: "MX kaydı için priority zorunlu." });
  }
  if (data.record_type === "SRV") {
    if (data.priority === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["priority"], message: "SRV kaydı için priority zorunlu." });
    }
    if (data.weight === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weight"], message: "SRV kaydı için weight zorunlu." });
    }
    if (data.port === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["port"], message: "SRV kaydı için port zorunlu." });
    }
  }
  if (data.record_type !== "MX" && data.record_type !== "SRV") {
    if (data.priority !== undefined || data.weight !== undefined || data.port !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["record_type"],
        message: "priority/weight/port yalnızca MX veya SRV kayıtlarında kullanılabilir.",
      });
    }
  }
});
export type CreateDnsRecordInput = z.infer<typeof createDnsRecordInputSchema>;

// .partial() burada bilerek KULLANILMIYOR: superRefine'lı bir şemanın
// üstüne .partial() çağrılamaz (ZodEffects .partial'ı desteklemez). Update
// zaten route seviyesinde mevcut satırla merge edilip createDnsRecordInputSchema
// ile yeniden doğrulanıyor (bkz. routes/dns.ts) — burası sadece "kısmi alan
// gönderilebilir" şeklini tanımlar, zorunluluk kontrolünü YAPMAZ.
export const updateDnsRecordInputSchema = createDnsRecordBaseSchema.partial();
export type UpdateDnsRecordInput = z.infer<typeof updateDnsRecordInputSchema>;

// Şemaya ek: auth cookie oturumları için (spesifikasyonda yok, login zorunlu kıldı).
export const sessionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int(),
  token_hash: z.string(),
  expires_at: z.coerce.date(),
  created_at: z.coerce.date(),
});
export type Session = z.infer<typeof sessionSchema>;

export const cgroupMetricsSchema = z.object({
  memory: z.object({
    limitBytes: z.number().nullable(),
    usedBytes: z.number(),
  }),
  cpu: z.object({
    quotaMicros: z.number().nullable(),
    periodMicros: z.number().nullable(),
    throttledUsec: z.number().nullable(),
    // cpu.stat > usage_usec. Konteynerin acilistan beri harcadigi toplam CPU
    // suresi; tek basina anlamli degil, iki ornek arasindaki farki alinir.
    usageUsec: z.number().nullable(),
    // KUMULATIF sayaclar: konteyner acilisindan beri toplam. Panelde tek
    // basina gosterilmez — gunler oncesinin toplami "su an sorun var" gibi
    // okunuyordu. Anlamli olan asagidaki pencere-ici alanlardir.
    nrThrottled: z.number().nullable(),
    nrPeriods: z.number().nullable(),
    // Son ornekleme penceresinde (iki okuma arasi) kotaya takilan periyot
    // sayisi ve o penceredeki toplam periyot sayisi. Ilk okumada referans
    // yok, bu yuzden null.
    throttledPeriodsDelta: z.number().nullable(),
    periodsDelta: z.number().nullable(),
    // Iki ornek arasindaki fark ile hesaplanan anlik kullanim yuzdesi.
    // Ilk ornekte referans yok, bu yuzden null.
    usagePercent: z.number().nullable(),
    // quotaMicros / periodMicros. cgroup limiti yoksa null.
    vcpus: z.number().nullable(),
  }),
  disk: z.object({
    path: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number(),
  }),
  sampledAt: z.coerce.date(),
});
export type CgroupMetrics = z.infer<typeof cgroupMetricsSchema>;

/** Gecmis grafigi icin tutulan tek ornek. Halka tamponda saklanir. */
export const metricsSampleSchema = z.object({
  /** Unix epoch milisaniye. */
  t: z.number(),
  cpuPercent: z.number().nullable(),
  memPercent: z.number().nullable(),
  memUsedBytes: z.number(),
  /**
   * Bu ornekleme araliginda kotaya takilan periyot sayisi ve o araliktaki
   * toplam periyot sayisi. KUMULATIF DEGIL — her ornek yalnizca kendi 5
   * saniyesini tasir. Grafik, secili aralikta bunlari toplayarak "son 30
   * dakikada ne kadar kota beklemesi oldu" sorusunu yanitlar.
   */
  throttledPeriods: z.number().nullable(),
  periods: z.number().nullable(),
});
export type MetricsSample = z.infer<typeof metricsSampleSchema>;

export const metricsHistoryRangeSchema = z.enum(["5m", "30m", "1h"]);
export type MetricsHistoryRange = z.infer<typeof metricsHistoryRangeSchema>;

export const metricsHistorySchema = z.object({
  samples: z.array(metricsSampleSchema),
  /** Ornekleme araligi (ms). Grafikte bosluk tespiti icin. */
  intervalMs: z.number(),
  /** Tamponun toplam kapasitesi (ornek adedi). */
  capacity: z.number(),
  range: metricsHistoryRangeSchema,
});
export type MetricsHistory = z.infer<typeof metricsHistorySchema>;

/* ---------------------------------------------------------------------------
 * Parola politikası — panelin TEK kaynağı
 * ------------------------------------------------------------------------- */

/**
 * Panelde açılan hesapların (e-posta, FTP, müşteri girişi) parola kuralı.
 *
 * NEDEN BURADA: kural daha önce dört ayrı yerde ve üç farklı değerle
 * yazılıydı (e-posta 12, FTP 12, müşteri 10, veritabanı 8). Aynı panelde
 * aynı işin üç farklı sınırı olması keyfî; kullanıcı hangi formda ne
 * isteneceğini bilemiyordu. Tek yerde tanımlanıp hem sunucu hem arayüz
 * tarafından okunuyor, böylece ikisi ayrışamaz.
 *
 * NEDEN 12 DEĞİL: 12 karakter dayatması kullanıcının makul parolalarını
 * ("Melih135." gibi) reddediyordu ve pratikte insanları parolayı boş bırakıp
 * üretilen rastgele diziyi bir yere yapıştırmaya itiyordu. Kural artık
 * uzunluk YA DA çeşitlilik istiyor:
 *
 *   - 12 karakter ve üzeri: başka koşul yok. Uzun bir parola ("kirmizi at
 *     mavi deniz") tek başına güçlüdür ve karmaşıklık dayatması onu
 *     ezberlenemez hale getirir.
 *   - 8-11 karakter: büyük harf, küçük harf, rakam ve simgeden en az ÜÇÜ.
 *     "Melih135." dördünü de taşır ve geçer; "melih135" ikisini taşır ve
 *     geçmez.
 *   - 8'in altı: kabul edilmez. Bu kutular internete açık (IMAP/SMTP/FTP)
 *     ve kaba kuvvet denemesi alıyorlar.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** Bu uzunluktan itibaren karakter çeşitliliği aranmaz. */
export const PASSWORD_RELAXED_LENGTH = 12;

/** Kısa parolalarda gereken en az karakter sınıfı sayısı. */
export const PASSWORD_MIN_CLASSES = 3;

function characterClasses(value: string): number {
  let classes = 0;
  if (/[a-zçğıöşü]/.test(value)) classes += 1;
  if (/[A-ZÇĞİÖŞÜ]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  // Harf ve rakam DIŞINDAKİ her şey simge sayılır (boşluk dahil — parola
  // cümlelerinde boşluk gerçek bir çeşitlilik kaynağıdır).
  if (/[^A-Za-z0-9ÇĞİÖŞÜçğıöşü]/.test(value)) classes += 1;
  return classes;
}

/**
 * Parola kuralı sağlanıyor mu. Sağlanıyorsa `null`, sağlanmıyorsa
 * kullanıcıya gösterilecek Türkçe sebep döner.
 */
export function passwordProblem(value: string): string | null {
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Parola en az ${PASSWORD_MIN_LENGTH} karakter olmalı — şu an ${value.length}.`;
  }
  if (value.length >= PASSWORD_RELAXED_LENGTH) return null;
  if (characterClasses(value) < PASSWORD_MIN_CLASSES) {
    return (
      `${PASSWORD_RELAXED_LENGTH} karakterden kısa parolalarda büyük harf, küçük harf, ` +
      `rakam ve simgeden en az ${PASSWORD_MIN_CLASSES} tanesi bulunmalı ` +
      `(örnek: Melih135.). Ya da ${PASSWORD_RELAXED_LENGTH} karakter ve üzeri bir parola yazın.`
    );
  }
  return null;
}

/** Formlarda gösterilecek tek satırlık kural özeti. */
export const PASSWORD_HINT =
  `En az ${PASSWORD_MIN_LENGTH} karakter. ${PASSWORD_RELAXED_LENGTH} karakterin altındaysa ` +
  `büyük harf, küçük harf, rakam ve simgeden en az ${PASSWORD_MIN_CLASSES} tanesini içermeli ` +
  `(örnek: Melih135.).`;

/**
 * Zod alanı. `.optional()` çağıran tarafta eklenir — bazı uçlarda parola
 * zorunlu, bazılarında boş bırakılınca üretiliyor.
 */
export const passwordField = z
  .string()
  .max(256)
  .superRefine((value, ctx) => {
    // superRefine kullaniliyor cunku mesaj DEGERE BAGLI: "en az 8 karakter"
    // ile "en az 3 karakter sinifi" ayri sebepler ve kullanici hangisine
    // takildigini gormeli. `.refine()` sabit bir mesaj alir.
    const problem = passwordProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
