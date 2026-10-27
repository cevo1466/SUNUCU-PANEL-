import type { Pool } from "pg";
import type { CgroupMetrics } from "@studio-panel/shared";
import { getLatestMetrics, startMetricsSampler } from "./metrics-history.js";
import { fetchHetrixUptimeMonitors } from "./hetrix.js";
import { formatAlertCard, isTelegramConfigured, sendTelegramMessage, type AlertTone } from "./telegram.js";
import {
  emptyAlertState,
  loadAlertState,
  saveAlertState,
  type PersistedAlertState,
} from "./alert-state.js";
import {
  decideUptime,
  formatOutage,
  initialUptimeState,
  type UptimeMonitorState,
  type UptimePolicyConfig,
} from "./uptime-policy.js";
import { env } from "../env.js";

const CHECK_INTERVAL_MS = env.ALERT_CHECK_INTERVAL_SEC * 1000;

/**
 * ALARM MİMARİSİ — TEK karar motoru, üç kaynak.
 *
 * Hem HetrixTools uptime monitörleri, hem sunucu kaynakları (CPU/RAM/disk),
 * hem de yerel servis sağlığı (web/nginx-docker/veritabanı) AYNI süre-bazlı
 * state machine'den (lib/uptime-policy.ts decideUptime) geçer. "down" burada
 * "eşik aşıldı" veya "servis yanıt vermiyor" da olabilir — kavramsal olarak
 * hepsi aynı soru: "bu sinyal ne kadar SÜREDİR kötü?".
 *
 * NEDEN (kullanıcı talebi, 2026-08-28 ikinci tur — "alarm kirliliğini
 * tamamen kesecek şekilde revize edelim"):
 *   - Anlık sıçramalar (1-2 sn drop, tek ping kaybı, CPU'nun anlık %100'e
 *     vurması) KESİNLİKLE bildirim üretmemeli.
 *   - Bir kriz ancak KESİNTİSİZ belirli bir süre sürerse bildirilir.
 *   - Düzelme ANINDA değil, KESİNTİSİZ bir süre STABİL kaldıktan sonra
 *     "RESOLVED" ile bildirilir (flap'in RESOLVED'i erken tetiklemesi
 *     engellenir — bkz. uptime-policy.ts).
 *   - Uzun kesintilerde sessizlik "unutuldu mu" izlenimi vermesin diye
 *     opsiyonel periyodik "hâlâ down" özeti (varsayılan 30 dk).
 *   - Eşiğin hemen altına/üstüne gezinme tekrar tekrar mesaj ÜRETMEMELİ
 *     (deadband/histerezis — isBadWithDeadband).
 */
const MEM_PERCENT_LIMIT = env.ALERT_MEM_PERCENT;
const MEM_PERCENT_RECOVER = MEM_PERCENT_LIMIT - 10;
const DISK_PERCENT_LIMIT = env.ALERT_DISK_PERCENT;
const DISK_PERCENT_RECOVER = DISK_PERCENT_LIMIT - 5;
const CPU_PERCENT_LIMIT = env.ALERT_CPU_PERCENT;
const CPU_PERCENT_RECOVER = CPU_PERCENT_LIMIT - 10;

const HETRIX_CONFIG: UptimePolicyConfig = {
  downAfterMinutes: env.ALERT_DOWN_AFTER_MINUTES,
  uptimePercentMin: env.ALERT_UPTIME_PERCENT_MIN,
  resolveAfterMinutes: env.ALERT_RESOLVE_AFTER_MINUTES,
  stillDownSummaryMinutes: env.ALERT_STILL_DOWN_SUMMARY_MINUTES,
};
// supervise.sh zaten 2 sn'de bir yeniden baslatmayi DENER — yerel servisler
// icin down esigi dis (Hetrix) esiginden kisa tutulur: birkac dakika sonra
// hala saglıksızsa gercek bir crash-loop var demektir, "aninda bildir"
// beklentisi bu kisa esikle karsilanir. Yuzde esigi kullanilmaz (0 = hic
// tetiklenmez, cunku asagida uptimePercent hep null gonderilir).
const LOCAL_SERVICE_CONFIG: UptimePolicyConfig = {
  downAfterMinutes: env.ALERT_LOCAL_DOWN_AFTER_MINUTES,
  uptimePercentMin: 0,
  resolveAfterMinutes: env.ALERT_RESOLVE_AFTER_MINUTES,
  stillDownSummaryMinutes: env.ALERT_STILL_DOWN_SUMMARY_MINUTES,
};
const MEMORY_CONFIG: UptimePolicyConfig = {
  downAfterMinutes: env.ALERT_MEM_SUSTAIN_MINUTES,
  uptimePercentMin: 0,
  resolveAfterMinutes: env.ALERT_RESOLVE_AFTER_MINUTES,
  stillDownSummaryMinutes: env.ALERT_STILL_DOWN_SUMMARY_MINUTES,
};
const DISK_CONFIG: UptimePolicyConfig = {
  downAfterMinutes: env.ALERT_DISK_SUSTAIN_MINUTES,
  uptimePercentMin: 0,
  resolveAfterMinutes: env.ALERT_RESOLVE_AFTER_MINUTES,
  stillDownSummaryMinutes: env.ALERT_STILL_DOWN_SUMMARY_MINUTES,
};
const CPU_CONFIG: UptimePolicyConfig = {
  downAfterMinutes: env.ALERT_CPU_SUSTAIN_MINUTES,
  uptimePercentMin: 0,
  resolveAfterMinutes: env.ALERT_RESOLVE_AFTER_MINUTES,
  stillDownSummaryMinutes: env.ALERT_STILL_DOWN_SUMMARY_MINUTES,
};

/**
 * Olu bantli ANLIK karar: alarm aktifken kurtulma esigi, aktif degilken
 * uyari esigi kullanilir. Tek esikli karsilastirmanin yarattigi salinim
 * boylece yapisal olarak imkansiz hale gelir. Bu, decideUptime'a giden
 * "isBad" sinyalinin KENDISI — sureye bakan asil karar decideUptime'da.
 */
const deadbandActive = new Map<string, boolean>();
export function isBadWithDeadband(
  key: string,
  value: number,
  alertAt: number,
  recoverBelow: number,
): boolean {
  const active = deadbandActive.get(key) ?? false;
  const isBad = active ? value >= recoverBelow : value >= alertAt;
  deadbandActive.set(key, isBad);
  return isBad;
}

/** Tum monitor turlerinin (hetrix/kaynak/yerel servis) TEK durum haritasi. */
const monitorStates = new Map<string, UptimeMonitorState>();

type MonitorCategory = "connectivity" | "resource";

const TONE_BY_CATEGORY: Record<MonitorCategory, { down: AlertTone; up: AlertTone }> = {
  // "CRITICAL: SUNUCU ERİŞİLEMEZ" / "RESOLVED: SİSTEM TEKRAR YAYINDA".
  connectivity: { down: "down", up: "up" },
  // Kaynak esigi asimi farkli bir sey soyler ("sunucu erisilemez" degil,
  // "CPU/RAM/disk esigi asildi") — ayri tonlar.
  resource: { down: "critical", up: "ok" },
};

/**
 * Tek bir monitörün (hetrix/kaynak/yerel servis fark etmez) güncel
 * gözlemini değerlendirir, gerekiyorsa Telegram'a gönderir. Tüm alarm
 * türlerinin ortak giriş noktası — bkz. dosya başı mimari notu.
 */
async function evaluateMonitor(
  key: string,
  name: string,
  category: MonitorCategory,
  isBad: boolean,
  config: UptimePolicyConfig,
  fields: Array<[string, string]>,
): Promise<void> {
  const previous = monitorStates.get(key) ?? initialUptimeState();
  const { state, decisions } = decideUptime(
    previous,
    { status: isBad ? "down" : "up", uptimePercent: null },
    Date.now(),
    config,
  );
  monitorStates.set(key, state);
  if (decisions.length === 0) return;

  const tones = TONE_BY_CATEGORY[category];
  for (const decision of decisions) {
    if (decision.kind === "down") {
      await sendTelegramMessage(
        formatAlertCard(tones.down, name, [
          ...fields,
          ["Süre", `${formatOutage(decision.outageMinutes)} kesintisiz`],
          ["Eşik", `${config.downAfterMinutes} dk`],
        ]),
      ).catch(() => undefined);
    } else if (decision.kind === "still-down") {
      await sendTelegramMessage(
        formatAlertCard("still-down", name, [...fields, ["Kesintisiz süre", formatOutage(decision.outageMinutes)]]),
      ).catch(() => undefined);
    } else if (decision.kind === "up") {
      await sendTelegramMessage(
        formatAlertCard(tones.up, name, [["Kesinti süresi", formatOutage(decision.outageMinutes)]]),
      ).catch(() => undefined);
    }
  }
  await persistState();
}

function memoryPercent(metrics: CgroupMetrics): number | null {
  const { limitBytes, usedBytes } = metrics.memory;
  return limitBytes && limitBytes > 0 ? (usedBytes / limitBytes) * 100 : null;
}

function diskPercent(metrics: CgroupMetrics): number | null {
  return metrics.disk.totalBytes > 0
    ? (metrics.disk.usedBytes / metrics.disk.totalBytes) * 100
    : null;
}

export async function checkResources(): Promise<void> {
  let metrics: CgroupMetrics;
  try {
    // DIKKAT: readCgroupMetrics() DOGRUDAN CAGRILMAZ, orneklecinin son
    // turundan okunur — bkz. metrics-history.ts (5 sn'lik pencereyi ezmemek
    // icin, gecmis oturumda gercekten yasanan bir hata).
    metrics = await getLatestMetrics();
  } catch {
    return;
  }

  const mem = memoryPercent(metrics);
  if (mem !== null) {
    await evaluateMonitor(
      "resource:memory",
      "Bellek",
      "resource",
      isBadWithDeadband("memory", mem, MEM_PERCENT_LIMIT, MEM_PERCENT_RECOVER),
      MEMORY_CONFIG,
      [
        ["Kullanım", `%${mem.toFixed(1)}`],
        ["Eşik", `%${MEM_PERCENT_LIMIT}`],
      ],
    );
  }

  const disk = diskPercent(metrics);
  if (disk !== null) {
    await evaluateMonitor(
      "resource:disk",
      "Disk",
      "resource",
      isBadWithDeadband("disk", disk, DISK_PERCENT_LIMIT, DISK_PERCENT_RECOVER),
      DISK_CONFIG,
      [
        ["Kullanım", `%${disk.toFixed(1)}`],
        ["Eşik", `%${DISK_PERCENT_LIMIT}`],
        ["Yol", metrics.disk.path],
      ],
    );
  }

  // CPU: throttle ORANI degil DOGRUDAN KULLANIM YUZDESI (kullanici talebi,
  // bkz. MEMORY.md 2026-08-28 — "anlik %100'e vurmalarda bildirim yok,
  // kesintisiz 5 dk %90 uzeri kalirsa uyar"). Onceki tasarim bilincli
  // olarak throttle oranini kullaniyordu (coklu-vCPU'da daha dogru sinyal
  // sayiliyordu) ama kullanici acikca yuzde+sure istedi; asil guvenlik agi
  // zaten SURE sartinda (5 dk), tek bir sivrilme hala zararsiz.
  if (metrics.cpu.usagePercent !== null) {
    await evaluateMonitor(
      "resource:cpu",
      "CPU",
      "resource",
      isBadWithDeadband("cpu", metrics.cpu.usagePercent, CPU_PERCENT_LIMIT, CPU_PERCENT_RECOVER),
      CPU_CONFIG,
      [
        ["Kullanım", `%${metrics.cpu.usagePercent.toFixed(1)}`],
        ["Eşik", `%${CPU_PERCENT_LIMIT}`],
        ["Limit", `${metrics.cpu.vcpus ?? "?"} vCPU`],
      ],
    );
  }
}

/** 5 sn zaman asimiyla basit bir HTTP saglik yoklamasi. service.sh port_healthy ile AYNI kural: sadece 000/502/503/504 saglıksız sayilir. */
async function httpHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
    return ![502, 503, 504].includes(res.status);
  } catch {
    return false;
  }
}

async function dbHealthy(pg: Pool): Promise<boolean> {
  try {
    await pg.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Yerel kritik servislerin saglik kontrolu (kullanici talebi: "Nginx / Docker
 * / DB veya ana backend servisi durursa ... aninda bildir"). API'nin kendisi
 * ayrica kontrol edilmez — bu kod calisiyorsa API zaten ayaktadir.
 *
 *   - web: Next.js (port 3000) — service.sh'teki AYNI port/health-path.
 *   - edge: 127.0.0.1:80 — proxy-server container'i (nginx + docker
 *     zincirinin TAMAMI) TEK bir HTTP istegiyle dogrulanir; docker.sock'a
 *     dokunmadan (guard.json'daki onay gerektiren yol) ayni sinyali verir.
 *   - db: panelin kendi PostgreSQL baglantisi (SELECT 1).
 */
export async function checkLocalServices(pg: Pool): Promise<void> {
  await evaluateMonitor(
    "local:web",
    "Web (Next.js)",
    "connectivity",
    !(await httpHealthy("http://127.0.0.1:3000/login")),
    LOCAL_SERVICE_CONFIG,
    [["Hedef", "127.0.0.1:3000"]],
  );
  await evaluateMonitor(
    "local:edge",
    "Nginx / Docker (Edge)",
    "connectivity",
    !(await httpHealthy("http://127.0.0.1/login")),
    LOCAL_SERVICE_CONFIG,
    [["Hedef", "127.0.0.1:80 (proxy-server)"]],
  );
  await evaluateMonitor(
    "local:db",
    "PostgreSQL",
    "connectivity",
    !(await dbHealthy(pg)),
    LOCAL_SERVICE_CONFIG,
    [["Hedef", "panel veritabanı"]],
  );
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Anlık, tek kart halinde kaynak + uptime özeti — alarm eşiklerinden ve
 * süre takibinden bağımsız, doğrudan "şu an ne durumdayız" raporu.
 * Telegram /durum komutu (bkz. telegram-bot.ts) bunu kullanır.
 *
 * Sayılar örnekleyicinin son turundan okunur (en fazla 5 saniye eski). Kendi
 * ölçümünü almaz: alacak olsaydı örnekleyicinin CPU penceresini bozar ve
 * panelde görünenden FARKLI bir yüzde raporlardı.
 */
export async function buildStatusReport(): Promise<string> {
  // Sunucu yeni acildiysa ornekleyici henuz calismamis olabilir; bu cagri
  // ilk ornegi almasini saglar.
  startMetricsSampler();
  const metrics = await getLatestMetrics();

  const mem = memoryPercent(metrics);
  const disk = diskPercent(metrics);
  const ageSec = Math.max(0, Math.round((Date.now() - metrics.sampledAt.getTime()) / 1000));

  const fields: Array<[string, string]> = [
    [
      "CPU",
      metrics.cpu.usagePercent !== null
        ? `%${metrics.cpu.usagePercent.toFixed(1)} · ${metrics.cpu.vcpus ?? "?"} vCPU`
        : `ölçülüyor · ${metrics.cpu.vcpus ?? "?"} vCPU`,
    ],
    [
      "Bellek",
      mem !== null
        ? `%${mem.toFixed(1)} · ${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.limitBytes ?? 0)}`
        : formatBytes(metrics.memory.usedBytes),
    ],
    [
      "Disk",
      disk !== null
        ? `%${disk.toFixed(1)} · ${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)}`
        : "bilinmiyor",
    ],
  ];

  let anyCritical = (mem !== null && mem >= MEM_PERCENT_LIMIT) || (disk !== null && disk >= DISK_PERCENT_LIMIT);

  // HetrixTools tarafi: erisilemezse rapor yine de gitmeli — kaynak bilgisi
  // Hetrix'e bagli degil, ayri bir kaynaktan (cgroup) geliyor.
  try {
    const uptime = await fetchHetrixUptimeMonitors();
    if (!uptime.configured) {
      fields.push(["Uptime", "HetrixTools bağlanmadı"]);
    } else if (!uptime.ok) {
      fields.push(["Uptime", `HetrixTools yanıt vermedi (${uptime.status})`]);
    } else if (uptime.monitors.length === 0) {
      fields.push(["Uptime", "Tanımlı monitör yok"]);
    } else {
      for (const monitor of uptime.monitors) {
        const isDown = monitor.uptime_status !== "up";
        if (isDown) anyCritical = true;
        const parts = [isDown ? `⛔ ${monitor.uptime_status}` : "✅ up"];
        if (monitor.uptime) parts.push(`%${Number(monitor.uptime).toFixed(2)}`);
        const ping = averageResponseMs(monitor);
        if (ping !== null) parts.push(`${ping} ms`);
        fields.push([monitor.name, parts.join(" · ")]);
      }
    }
  } catch (err) {
    fields.push(["Uptime", `okunamadı: ${(err as Error).message}`]);
  }

  fields.push(["Ölçüm yaşı", `${ageSec} sn önce`]);

  return formatAlertCard(anyCritical ? "critical" : "status", "Kaynak ve Uptime", fields);
}

/** Monitörün kontrol noktalarındaki yanıt sürelerinin ortalaması (ms). */
function averageResponseMs(monitor: {
  locations?: Record<string, { response_time?: number }>;
}): number | null {
  const values = Object.values(monitor.locations ?? {})
    .map((l) => l.response_time)
    .filter((v): v is number => typeof v === "number" && v > 0);
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Test icin disa acildi (bkz. self-test.ts "ag hatasi cokme" regresyonu).
 * Uretimde yalnizca startAlertMonitor()'un turu cagirir.
 */
export async function checkUptime(): Promise<void> {
  // HetrixTools'a giden istek AG HATASI ile reddedilebilir (DNS EAI_AGAIN,
  // ConnectTimeout, ECONNRESET — hepsi loglarda gorüldü). Bu fonksiyon
  // `void checkUptime()` ile cagriliyordu; yakalanmayan reddi Node varsayilan
  // olarak SUREC COKMESI sayar. Yani panelin API'si, ucuncu taraf bir izleme
  // servisine bir saniyeligine ulasamadigi icin tamamen oluyor ve panel 502
  // veriyordu. Ag hatasi burada yutulur: izleme verisi gelmezse bir sonraki
  // tur yeniden dener.
  let result: Awaited<ReturnType<typeof fetchHetrixUptimeMonitors>>;
  try {
    result = await fetchHetrixUptimeMonitors();
  } catch {
    return;
  }
  if (!result.configured || !result.ok) return;

  for (const monitor of result.monitors) {
    const parsedPercent = monitor.uptime === undefined ? NaN : Number(monitor.uptime);
    // Yuzde esigi decideUptime icinde AYRICA degerlendiriliyor (percent
    // decision) — bu yuzden HETRIX_CONFIG'i degil, onun uzerine
    // uptimePercent tasiyan tam config'i kullanmamiz gerekiyor; evaluateMonitor
    // "isBad" (down/up) ile percent'i BIRLIKTE degerlendiremedigi icin percent
    // burada AYRI bir decideUptime cagrisiyla ele alinir (asagida).
    await evaluateHetrixMonitor(
      `hetrix:${monitor.id}`,
      monitor.name,
      monitor.uptime_status !== "up",
      Number.isFinite(parsedPercent) ? parsedPercent : null,
      [
        ["Hedef", `${monitor.target}${monitor.port ? `:${monitor.port}` : ""}`],
        ["Tür", monitor.type],
      ],
    );
  }
}

/**
 * checkUptime'a ozel: evaluateMonitor'dan farkli olarak yuzde esigini de
 * (percent decision) isler — HetrixTools disindaki hicbir kaynak (yerel
 * servis/kaynak esigi) yuzde raporlamadigi icin bu dallanma yalnizca burada
 * gerekli, evaluateMonitor'u genel amacli tutmak icin ayri fonksiyon.
 */
async function evaluateHetrixMonitor(
  key: string,
  name: string,
  isDown: boolean,
  uptimePercent: number | null,
  fields: Array<[string, string]>,
): Promise<void> {
  const previous = monitorStates.get(key) ?? initialUptimeState();
  const { state, decisions } = decideUptime(
    previous,
    { status: isDown ? "down" : "up", uptimePercent },
    Date.now(),
    HETRIX_CONFIG,
  );
  monitorStates.set(key, state);
  if (decisions.length === 0) return;

  for (const decision of decisions) {
    if (decision.kind === "down") {
      await sendTelegramMessage(
        formatAlertCard("down", name, [
          ...fields,
          ["Süre", `${formatOutage(decision.outageMinutes)} kesintisiz`],
          ["Eşik", `${HETRIX_CONFIG.downAfterMinutes} dk`],
        ]),
      ).catch(() => undefined);
    } else if (decision.kind === "still-down") {
      await sendTelegramMessage(
        formatAlertCard("still-down", name, [...fields, ["Kesintisiz süre", formatOutage(decision.outageMinutes)]]),
      ).catch(() => undefined);
    } else if (decision.kind === "up") {
      await sendTelegramMessage(
        formatAlertCard("up", name, [["Kesinti süresi", formatOutage(decision.outageMinutes)]]),
      ).catch(() => undefined);
    } else {
      await sendTelegramMessage(
        formatAlertCard("critical", `${name} — uptime düştü`, [
          ["Uptime", `%${decision.uptimePercent.toFixed(2)}`],
          ["Eşik", `%${HETRIX_CONFIG.uptimePercentMin}`],
          ...fields,
          ["Not", "Kısa ama sık kesintiler birikiyor olabilir"],
        ]),
      ).catch(() => undefined);
    }
  }
  await persistState();
}

/** Bellekteki durumu diske yazar (bkz. alert-state.ts gerekcesi). */
async function persistState(): Promise<void> {
  const state: PersistedAlertState = emptyAlertState();
  for (const [key, value] of monitorStates) state.monitors[key] = { ...value };
  await saveAlertState(state);
}

/**
 * Onceki calismadan kalan alarm durumunu geri yukler. Bu yapilmazsa her
 * yeniden baslatma bastirilmis alarmlari yeniden ateslerdi.
 */
async function restoreState(): Promise<void> {
  const saved = await loadAlertState();
  for (const [key, value] of Object.entries(saved.monitors)) monitorStates.set(key, value);
}

let timer: NodeJS.Timeout | null = null;

/**
 * Kaynak limiti aşımı, yerel servis çöküşü ve HetrixTools uptime
 * değişikliklerini Telegram'a bildirir. TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
 * tanımlı değilse sendTelegramMessage sessizce no-op olduğundan burada da
 * ekstra bir kontrol gerekmez — döngü yine de çalışır ama hiçbir mesaj
 * göndermez.
 *
 * `pg`: yerel PostgreSQL sağlık kontrolü için (bkz. checkLocalServices).
 * server.ts fastify.listen() sonrası fastify.pg ile çağırır.
 */
export function startAlertMonitor(pg: Pool): void {
  if (timer) return;
  if (!isTelegramConfigured()) return;
  // Alarmlar ornekleyicinin verisini okur; rota kaydindan bagimsiz olarak
  // ornekleyicinin ayakta oldugundan burada da emin oluyoruz (idempotent).
  startMetricsSampler();
  // Her kontrol de kendi icinde hata yutuyor; buradaki `.catch()`
  // son emniyet kemeri: beklenmedik bir red HICBIR kosulda surece
  // "unhandled rejection" olarak sizmasin (Node bunu cokmeyle cezalandirir).
  const tick = () => {
    void checkResources().catch(() => undefined);
    void checkLocalServices(pg).catch(() => undefined);
    void checkUptime().catch(() => undefined);
  };
  // Ilk tur, onceki calismadan kalan durum GERI YUKLENDIKTEN sonra calisir.
  // Aksi halde durum yuklenmeden once bastirilmis bir alarm yeniden
  // ateslenebilirdi — ki bu tam olarak duzeltmeye calistigimiz sey.
  void restoreState()
    .catch(() => undefined)
    .then(tick);
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopAlertMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
