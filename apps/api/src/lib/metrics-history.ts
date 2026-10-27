import type { CgroupMetrics, MetricsHistoryRange, MetricsSample } from "@studio-panel/shared";
import { readCgroupMetrics } from "./cgroup.js";
import { env } from "../env.js";

/**
 * Kaynak kullanımı geçmişi — süreç içi halka tampon.
 *
 * Neden DB değil: grafik son bir saati gösteriyor, veri kalıcı olmak zorunda
 * değil ve her 5 saniyede bir satır yazmak PostgreSQL'e gereksiz yük. Tampon
 * sabit boyutlu, bu yüzden bellek kullanımı sabit (~720 × 4 sayı).
 *
 * ÖNEMLİ: readCgroupMetrics() içindeki CPU yüzdesi iki ardışık okuma arasındaki
 * usage_usec farkından hesaplanır ve bu fark modül seviyesinde tutulur. Bu
 * yüzden cgroup'u okuyan TEK yer burasıdır — HTTP istekleri readCgroupMetrics()
 * çağırmaz, son örneği okur. Aksi halde iki okuyucu birbirinin referans
 * noktasını ezer ve yüzde anlamsızlaşır.
 */

const INTERVAL_MS = 5_000;
const CAPACITY = 720; // 720 × 5 sn = 1 saat

const RANGE_MS: Record<MetricsHistoryRange, number> = {
  "5m": 5 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
};

const buffer: MetricsSample[] = [];
let latest: CgroupMetrics | null = null;
let lastError: string | null = null;
let timer: NodeJS.Timeout | null = null;

function toSample(metrics: CgroupMetrics): MetricsSample {
  const { limitBytes, usedBytes } = metrics.memory;
  return {
    t: metrics.sampledAt.getTime(),
    cpuPercent: metrics.cpu.usagePercent,
    memPercent:
      limitBytes && limitBytes > 0
        ? Number(((usedBytes / limitBytes) * 100).toFixed(1))
        : null,
    memUsedBytes: usedBytes,
    // Kümülatif sayaç değil, YALNIZCA bu 5 saniyelik pencerenin farkı.
    // Grafik seçili aralıkta bunları toplar; böylece "son 30 dakikada"
    // gibi gerçekten bir zaman aralığına ait bir sayı gösterilebilir.
    throttledPeriods: metrics.cpu.throttledPeriodsDelta,
    periods: metrics.cpu.periodsDelta,
  };
}

async function sample(): Promise<void> {
  try {
    const metrics = await readCgroupMetrics(env.VHOSTS_ROOT);
    latest = metrics;
    lastError = null;

    buffer.push(toSample(metrics));
    if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
  } catch (err) {
    // Örnekleyici hiçbir zaman ölmemeli: bir okuma başarısız olursa hatayı
    // saklayıp bir sonraki turda tekrar deniyoruz.
    lastError = err instanceof Error ? err.message : String(err);
  }
}

export function startMetricsSampler(): void {
  if (timer) return;
  void sample();
  timer = setInterval(() => void sample(), INTERVAL_MS);
  // Örnekleyici tek başına Node'un kapanmasını engellemesin.
  timer.unref?.();
}

export function stopMetricsSampler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Son ölçüm. Örnekleyici henüz ilk turunu bitirmediyse bir kez bekler —
 * böylece sunucu açıldıktan hemen sonra gelen istek boş dönmez.
 */
export async function getLatestMetrics(): Promise<CgroupMetrics> {
  if (!latest) await sample();
  if (!latest) throw new Error(lastError ?? "cgroup metrikleri okunamadı");
  return latest;
}

/**
 * Bir zaman penceresindeki TOPLAM throttle sayilari.
 *
 * Neden gerekli: `metrics.cpu.throttledPeriodsDelta` yalnizca SON 5 saniyelik
 * ornegin farkidir. Alarm izleyicisi 30 saniyede bir baktigi icin tek bir
 * ornege bakmak, aradaki 25 saniyede yasanan throttle'i tamamen kacirir.
 * Halka tampon zaten pencere farklarini tutuyor; burada toplaniyor.
 */
export function getThrottleWindow(windowMs: number): {
  throttledPeriods: number | null;
  periods: number | null;
} {
  const since = Date.now() - windowMs;
  const samples = buffer.filter((s) => s.t >= since);
  if (samples.length === 0) return { throttledPeriods: null, periods: null };

  let throttled: number | null = null;
  let periods: number | null = null;
  for (const s of samples) {
    if (s.throttledPeriods !== null) throttled = (throttled ?? 0) + s.throttledPeriods;
    if (s.periods !== null) periods = (periods ?? 0) + s.periods;
  }
  return { throttledPeriods: throttled, periods };
}

export function getHistory(range: MetricsHistoryRange) {
  const since = Date.now() - RANGE_MS[range];
  return {
    samples: buffer.filter((s) => s.t >= since),
    intervalMs: INTERVAL_MS,
    capacity: CAPACITY,
    range,
  };
}
