/**
 * Bellek içi oturum-açma hız sınırı. Tek süreçli API için yeterli; yeniden
 * başlatma sayaçları sıfırlar (kabul edilebilir: saldırgan kazancı sınırlı).
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function hitRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
