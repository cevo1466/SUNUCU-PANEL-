import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import type { CgroupMetrics } from "@studio-panel/shared";

const execFileAsync = promisify(execFile);
const CGROUP_ROOT = "/sys/fs/cgroup";

async function readFileSafe(relPath: string): Promise<string | null> {
  try {
    return (await fs.readFile(`${CGROUP_ROOT}/${relPath}`, "utf8")).trim();
  } catch {
    return null;
  }
}

function parseMax(value: string | null): number | null {
  if (value === null) return null;
  if (value === "max") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// cgroup v2 dosyalarını gerçekten okur (mock yok). Bu container'da
// /sys/fs/cgroup/memory.max, memory.current, cpu.max, cpu.stat okunabilir
// olduğu doğrulandı. Limitler dosyadan okunur, koda gömülmez — operatör
// konteyner limitini değiştirdiğinde panel yeniden derlenmeden uyum sağlar.
async function readCpuMax(): Promise<{
  quotaMicros: number | null;
  periodMicros: number | null;
}> {
  const raw = await readFileSafe("cpu.max");
  if (!raw) return { quotaMicros: null, periodMicros: null };
  const [quota, period] = raw.split(/\s+/);
  return {
    quotaMicros: quota === "max" ? null : Number(quota),
    periodMicros: Number(period),
  };
}

/**
 * cpu.stat tek okumada birden fazla sayaç taşır; dosyayı üç kez açmak yerine
 * bir kez okuyup ilgili satırları ayıklıyoruz.
 *   usage_usec     — açılıştan beri harcanan toplam CPU süresi (kümülatif)
 *   throttled_usec — kota dolduğu için beklenen süre (kümülatif)
 *   nr_throttled   — kaç periyotta kotaya takıldığı (kümülatif)
 *   nr_periods     — toplam kaç kota periyodu yaşandığı (kümülatif)
 *
 * Dördü de kümülatiftir ve konteyner ayakta olduğu sürece asla sıfırlanmaz.
 * `nr_throttled`'ı ham göstermek yanıltıcıydı ("338 kez kotaya takıldı" günler
 * öncesinin toplamıydı), bu yüzden aşağıda pencere farkı da hesaplanıyor.
 */
async function readCpuStat(): Promise<{
  usageUsec: number | null;
  throttledUsec: number | null;
  nrThrottled: number | null;
  nrPeriods: number | null;
}> {
  const raw = await readFileSafe("cpu.stat");
  if (!raw) {
    return { usageUsec: null, throttledUsec: null, nrThrottled: null, nrPeriods: null };
  }

  const pick = (key: string): number | null => {
    const line = raw.split("\n").find((l) => l.startsWith(`${key} `));
    if (!line) return null;
    const n = Number(line.split(/\s+/)[1]);
    return Number.isFinite(n) ? n : null;
  };

  return {
    usageUsec: pick("usage_usec"),
    throttledUsec: pick("throttled_usec"),
    nrThrottled: pick("nr_throttled"),
    nrPeriods: pick("nr_periods"),
  };
}

// cpu.stat'taki sayaçların hepsi kümülatiftir; tek başlarına anlamı yok.
// Anlamlı olan iki ardışık okuma arasındaki FARK. Önceki okuma modül
// seviyesinde tutuluyor çünkü sayaçlar sürecin tamamı için tek ve global.
//
// Üç değer TEK bir kayıtta tutuluyor: kullanım yüzdesi ile throttle farkı
// aynı pencereye ait olmalı. Ayrı ayrı saklansalardı biri güncellenip diğeri
// güncellenmediğinde pencereler kayardı.
let previousCpuReading: {
  usageUsec: number;
  nrThrottled: number | null;
  nrPeriods: number | null;
  atMs: number;
} | null = null;

interface CpuWindow {
  /** 0-100 arası kullanım yüzdesi; ilk okumada (referans yokken) null. */
  usagePercent: number | null;
  /** Bu pencerede kotaya takılan periyot sayısı. */
  throttledPeriodsDelta: number | null;
  /** Bu penceredeki toplam kota periyodu sayısı. */
  periodsDelta: number | null;
}

/**
 * Bir önceki okumayla farkı alıp pencere değerlerini üretir ve referansı
 * günceller. vCPU sayısına göre normalize edilir: bütün çekirdekler doluysa
 * %100.
 */
function computeCpuWindow(
  stat: { usageUsec: number | null; nrThrottled: number | null; nrPeriods: number | null },
  vcpus: number | null,
): CpuWindow {
  const now = Date.now();
  const empty: CpuWindow = {
    usagePercent: null,
    throttledPeriodsDelta: null,
    periodsDelta: null,
  };

  if (stat.usageUsec === null) {
    previousCpuReading = null;
    return empty;
  }

  const previous = previousCpuReading;
  previousCpuReading = {
    usageUsec: stat.usageUsec,
    nrThrottled: stat.nrThrottled,
    nrPeriods: stat.nrPeriods,
    atMs: now,
  };

  if (!previous) return empty;

  const elapsedMs = now - previous.atMs;
  const deltaUsage = stat.usageUsec - previous.usageUsec;
  // Saat geri alındıysa, sayaç sıfırlandıysa veya iki okuma aynı ana denk
  // geldiyse anlamlı bir oran çıkmaz.
  if (elapsedMs <= 0 || deltaUsage < 0) return empty;

  const cores = vcpus && vcpus > 0 ? vcpus : 1;
  const percent = (deltaUsage / (elapsedMs * 1000)) * (100 / cores);

  // Sayaç geriye gidemez; gittiyse (konteyner yeniden başladı) pencereyi
  // atlıyoruz — negatif bir "throttle sayısı" uydurmaktansa null daha dürüst.
  const delta = (current: number | null, before: number | null): number | null => {
    if (current === null || before === null) return null;
    const diff = current - before;
    return diff < 0 ? null : diff;
  };

  return {
    usagePercent: Math.min(100, Math.max(0, Number(percent.toFixed(1)))),
    throttledPeriodsDelta: delta(stat.nrThrottled, previous.nrThrottled),
    periodsDelta: delta(stat.nrPeriods, previous.nrPeriods),
  };
}

async function readReclaimableFileBytes(): Promise<number> {
  const raw = await readFileSafe("memory.stat");
  if (!raw) return 0;
  const line = raw.split("\n").find((entry) => entry.startsWith("inactive_file "));
  if (!line) return 0;
  const bytes = Number(line.split(/\s+/)[1]);
  return Number.isFinite(bytes) ? bytes : 0;
}

async function readDiskUsage(targetPath: string) {
  // busybox df -k → satır: Filesystem 1K-blocks Used Available Use% Mounted-on
  const { stdout } = await execFileAsync("df", ["-k", targetPath]);
  const lines = stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  const cols = last.trim().split(/\s+/);
  const totalKb = Number(cols[1]);
  const usedKb = Number(cols[2]);
  const availKb = Number(cols[3]);
  return {
    path: targetPath,
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    availableBytes: availKb * 1024,
  };
}

export async function readCgroupMetrics(
  diskPath = "/var/www/vhosts",
): Promise<CgroupMetrics> {
  const [memMax, memCurrent, reclaimableFileBytes, cpuMax, cpuStat, disk] = await Promise.all([
    readFileSafe("memory.max"),
    readFileSafe("memory.current"),
    readReclaimableFileBytes(),
    readCpuMax(),
    readCpuStat(),
    readDiskUsage(diskPath),
  ]);

  // A dedicated VDS need not set a Docker CPU quota. In that case cpu.max is
  // "max", but CPU utilization still needs the CPUs available to this process.
  const cpuQuota =
    cpuMax.quotaMicros !== null && cpuMax.periodMicros
      ? cpuMax.quotaMicros / cpuMax.periodMicros
      : null;
  const vcpus = cpuQuota && cpuQuota > 0 ? cpuQuota : availableParallelism();

  const cpuWindow = computeCpuWindow(cpuStat, vcpus);

  return {
    memory: {
      limitBytes: parseMax(memMax),
      // memory.current ayrıca geri kazanılabilir page cache'i de içerir.
      // Panelde gerçek çalışma setini göstermek için inactive_file'ı çıkarıyoruz.
      usedBytes: Math.max(0, Number(memCurrent ?? 0) - reclaimableFileBytes),
    },
    cpu: {
      quotaMicros: cpuMax.quotaMicros,
      periodMicros: cpuMax.periodMicros,
      throttledUsec: cpuStat.throttledUsec,
      usageUsec: cpuStat.usageUsec,
      nrThrottled: cpuStat.nrThrottled,
      nrPeriods: cpuStat.nrPeriods,
      throttledPeriodsDelta: cpuWindow.throttledPeriodsDelta,
      periodsDelta: cpuWindow.periodsDelta,
      usagePercent: cpuWindow.usagePercent,
      vcpus,
    },
    disk,
    sampledAt: new Date(),
  };
}
