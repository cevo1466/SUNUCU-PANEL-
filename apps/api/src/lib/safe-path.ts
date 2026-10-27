import path from "node:path";
import fs from "node:fs/promises";

// Paylaşılan path-traversal savunması. AGENTS.md § Security:
// "Tüm dosya sistemi işlemleri yalnızca /var/www/vhosts altında yapılır;
// path normalizasyonu sonrası kök dışına çıkan istekler 403 ile reddedilir."
// Modül 1 (domains.ts/domain.ts) ve Modül 4 (files.ts/backups.ts) AYNI
// yardımcıyı kullanır — kök hesabı iki yerde ayrı ayrı yazılmaz.

export class PathTraversalError extends Error {}

export interface SafeRoot {
  resolved: string;
}

export function makeSafeRoot(root: string): SafeRoot {
  return { resolved: path.resolve(root) };
}

function withTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

/**
 * `userPath`'i `root` altında güvenli bir mutlak yola çözer.
 *
 * Savunma katmanları:
 * 1. Null byte reddi (ham VE decode edilmiş halde).
 * 2. URL-encode edilmiş traversal (`%2e%2e%2f`, `..%2f`) decodeURIComponent
 *    ile açığa çıkarılıp normal path gibi kontrol edilir.
 * 3. `path.join(root, userPath)` — `path.resolve` gibi "ikinci argüman
 *    mutlaksa öncekini eze geçer" tuzağı YOK (klasik Node.js path-traversal
 *    hatası). `/etc/passwd` gibi mutlak bir userPath bile root'un ALTINA
 *    (`root/etc/passwd`) birleştirilir, kaçamaz.
 * 4. `path.resolve` ile lexical normalize (`..` segmentleri çözülür).
 * 5. Sonucun `root` önekiyle başladığı kontrol edilir — normalizasyon
 *    SONRASI kök dışına çıkan HER İSTEK burada reddedilir.
 *
 * Sembolik link kaçışı için ayrıca bkz. `assertNoSymlinkEscape` — bu
 * fonksiyon SADECE lexical (senkron, dosya sistemine dokunmayan) kontrol
 * yapar; gerçek dosya/sembolik link kontrolü işlem öncesi ayrıca yapılmalı.
 */
export function resolveWithinRoot(root: SafeRoot, userPath: string): string {
  if (typeof userPath !== "string") {
    throw new PathTraversalError("Geçersiz yol.");
  }
  if (userPath.includes("\0")) {
    throw new PathTraversalError("Geçersiz karakter (null byte).");
  }

  let decoded = userPath;
  try {
    // Birden fazla encode katmanı olabilir (örn. %252e%252e) — tek seferlik
    // decode yeterli olmayabilir ama tekrarlı decode DOS riski taşıdığından
    // (ve gerçek istemciler çift encode göndermediğinden) tek seferle
    // sınırlıyoruz; kalan "%2e" dizileri normalize sonrası zaten kök dışına
    // çıkmaz çünkü path.join/resolve bunları harf olarak değerlendirir.
    decoded = decodeURIComponent(userPath);
  } catch {
    throw new PathTraversalError("Geçersiz URL kodlaması.");
  }
  if (decoded.includes("\0")) {
    throw new PathTraversalError("Geçersiz karakter (null byte).");
  }

  const joined = path.join(root.resolved, decoded);
  const candidate = path.resolve(joined);

  const rootWithSep = withTrailingSep(root.resolved);
  if (candidate !== root.resolved && !candidate.startsWith(rootWithSep)) {
    throw new PathTraversalError("Yol kök dizinin dışına çıkıyor.");
  }
  return candidate;
}

/**
 * Gerçek (symlink çözülmüş) yolun hâlâ `root` içinde olduğunu doğrular.
 * `targetPath` henüz var olmayabilir (örn. yeni dosya oluşturma) — bu
 * durumda en yakın VAR OLAN atasının gerçek yolu kontrol edilir; o ata bir
 * sembolik linkle kök dışına çıkıyorsa istek reddedilir.
 */
export async function assertNoSymlinkEscape(root: SafeRoot, targetPath: string): Promise<void> {
  const rootReal = await fs.realpath(root.resolved).catch(() => root.resolved);
  const rootWithSep = withTrailingSep(rootReal);

  let probe = targetPath;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = await fs.realpath(probe);
      if (real !== rootReal && !real.startsWith(rootWithSep)) {
        throw new PathTraversalError("Sembolik link kök dizinin dışına çıkıyor.");
      }
      return;
    } catch (err) {
      if (err instanceof PathTraversalError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return; // dosya sistemi köküne ulaşıldı, ata bulunamadı
      probe = parent;
    }
  }
}
