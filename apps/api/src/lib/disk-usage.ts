import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomainName, domainRootPath, directoryExists } from "./domain.js";

const execFileAsync = promisify(execFile);

/**
 * Domain dizinlerinin disk kullanımı.
 *
 * NEDEN AYRI BİR UÇ NOKTA (ve /api/domains içinde DEĞİL): `du` dizini gerçekten
 * gezer. Bu konteynerde 365 MB'lık tek bir domain için ~1.7 saniye sürüyor;
 * domain listesine gömülseydi domainler sayfası her açılışta o kadar
 * beklerdi. Liste hızlı gelir, kullanım ayrı istekle sonradan dolar.
 *
 * ÖLÇÜ BİRİMİ — `du -sk`, yani DISKTE KAPLANAN blok alanı (kibibayt), dosya
 * boyutlarının toplamı değil. İkisi ciddi biçimde ayrışır: aynı dizin için
 * `du -sb` (görünür boyut) 324 MB derken `du -sk` 357 MB veriyor — fark blok
 * artıkları ve dizin girdileri. Hosting kotası açısından doğru cevap diskte
 * kaplanan alandır, bu yüzden -k seçildi. busybox du'da ikisi de var.
 */

/** Önbellek ömrü. `du` pahalı; panel açıkken her yenilemede yeniden gezilmesin. */
const CACHE_TTL_MS = 120_000;

/**
 * Tek bir ölçüm için tavan süre. Çok büyük veya ağ üzerinden bağlı bir dizin
 * paneli süresiz bekletmesin — süre dolarsa o domain "ölçülemedi" döner,
 * istek tümden başarısız olmaz.
 */
const MEASURE_TIMEOUT_MS = 20_000;

/**
 * Aynı anda kaç `du` çalışsın. `du` CPU değil DİSK bağımlı; hepsini paralel
 * başlatmak konteynerin I/O'sunu doyurup canlı siteleri de yavaşlatır.
 * İkili sıra, tek tek beklemekten belirgin hızlı ve disk için hâlâ nazik.
 */
const MEASURE_CONCURRENCY = 2;

export interface DomainDiskUsage {
  domain_name: string;
  /** Diskte kaplanan alan. Ölçülemediyse null. */
  bytes: number | null;
  /** Dizin hiç yoksa (henüz oluşturulmamış domain) true; bytes 0 döner. */
  missing: boolean;
  /** Ölçümün alındığı an (önbellekten geldiyse ESKİ bir zaman olabilir). */
  measured_at: string;
  /** Ölçüm başarısızsa insan okur bir sebep. */
  error?: string;
}

interface CacheEntry {
  bytes: number | null;
  missing: boolean;
  measuredAt: number;
  error?: string;
}

const cache = new Map<string, CacheEntry>();

/** Test ve "yenile" düğmesi için: önbelleği boşaltır. */
export function clearDiskUsageCache(): void {
  cache.clear();
}

async function measure(domainName: string): Promise<CacheEntry> {
  const now = Date.now();
  try {
    assertValidDomainName(domainName);
  } catch (err) {
    return { bytes: null, missing: false, measuredAt: now, error: (err as Error).message };
  }

  const root = domainRootPath(domainName);
  if (!directoryExists(root)) {
    return { bytes: 0, missing: true, measuredAt: now };
  }

  try {
    // Yol argüman olarak geçiyor (kabuk yok): execFile shell açmaz, bu yüzden
    // dizin adındaki hiçbir karakter komut olarak yorumlanamaz.
    const { stdout } = await execFileAsync("du", ["-sk", root], {
      timeout: MEASURE_TIMEOUT_MS,
      maxBuffer: 1024 * 64,
    });
    // "365452\t/var/www/vhosts/example.com"
    const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    if (!Number.isFinite(kib)) {
      return { bytes: null, missing: false, measuredAt: now, error: "du çıktısı okunamadı." };
    }
    return { bytes: kib * 1024, missing: false, measuredAt: now };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; message?: string };
    const timedOut = e.killed === true || e.signal === "SIGTERM";
    return {
      bytes: null,
      missing: false,
      measuredAt: now,
      error: timedOut
        ? `Ölçüm ${MEASURE_TIMEOUT_MS / 1000} saniyede tamamlanmadı (dizin çok büyük olabilir).`
        : `Ölçülemedi: ${e.message ?? "bilinmeyen hata"}`,
    };
  }
}

async function usageFor(domainName: string, useCache: boolean): Promise<DomainDiskUsage> {
  const cached = cache.get(domainName);
  if (useCache && cached && Date.now() - cached.measuredAt < CACHE_TTL_MS) {
    return {
      domain_name: domainName,
      bytes: cached.bytes,
      missing: cached.missing,
      measured_at: new Date(cached.measuredAt).toISOString(),
      ...(cached.error ? { error: cached.error } : {}),
    };
  }
  const fresh = await measure(domainName);
  cache.set(domainName, fresh);
  return {
    domain_name: domainName,
    bytes: fresh.bytes,
    missing: fresh.missing,
    measured_at: new Date(fresh.measuredAt).toISOString(),
    ...(fresh.error ? { error: fresh.error } : {}),
  };
}

/**
 * Verilen domainlerin disk kullanımını ölçer.
 *
 * Sıra korunur: çağıran, gelen diziyi girdi sırasıyla eşleştirebilir.
 * Tek bir domain'in ölçümü patlarsa yalnızca o domain `error` ile döner —
 * bir domain yüzünden tüm liste kaybolmaz.
 */
export async function domainsDiskUsage(
  domainNames: string[],
  options: { refresh?: boolean } = {},
): Promise<DomainDiskUsage[]> {
  const useCache = options.refresh !== true;
  const results: DomainDiskUsage[] = new Array(domainNames.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= domainNames.length) return;
      results[index] = await usageFor(domainNames[index], useCache);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MEASURE_CONCURRENCY, domainNames.length) }, () => worker()),
  );
  return results;
}
