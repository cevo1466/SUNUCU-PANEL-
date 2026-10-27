const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals).replace(".", ",")} ${BYTE_UNITS[unitIndex]}`;
}

export function formatPercent(used: number, total: number | null): string {
  if (!total) return "—";
  return `%${((used / total) * 100).toFixed(1).replace(".", ",")}`;
}

export function percentOf(used: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return (used / total) * 100;
}

/** Ölçü çubuğu ve grafiklerde eşik durumu. Renk tek başına kullanılmaz; her
 *  zaman yanında bir metin etiketi bulunur. */
export type Threshold = "ok" | "warn" | "err";

export function thresholdOf(percent: number | null): Threshold {
  if (percent === null) return "ok";
  if (percent >= 90) return "err";
  if (percent >= 75) return "warn";
  return "ok";
}

export const THRESHOLD_LABEL: Record<Threshold, string> = {
  ok: "normal",
  warn: "yüksek",
  err: "kritik",
};

/** Aktarım hızı. Yükleme ilerlemesinde saniyelik bayt akışını gösterir. */
export function formatBytesPerSecond(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/sn`;
}

/**
 * Kalan süre — "2 dk 30 sn" gibi.
 *
 * Saniye cinsinden ham sayı ("150 sn") büyük yüklemelerde okunmuyor; kullanıcı
 * ne kadar bekleyeceğini anlamak için zihninden bölmek zorunda kalıyordu.
 * Belirsizse (hız henüz ölçülemedi) "—" döner; uydurma bir tahmin verilmez.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total} sn`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} dk` : `${minutes} dk ${rest} sn`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} sa` : `${hours} sa ${restMinutes} dk`;
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("tr-TR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatClock(value: number | Date): string {
  return new Date(value).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "3 gün sonra" / "12 gün önce" — SSL bitiş tarihleri için. */
export function relativeDays(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return "bugün";
  if (days > 0) return `${days} gün sonra`;
  return `${Math.abs(days)} gün önce`;
}
