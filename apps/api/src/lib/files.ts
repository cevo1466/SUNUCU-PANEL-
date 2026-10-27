import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  makeSafeRoot,
  resolveWithinRoot,
  assertNoSymlinkEscape,
  PathTraversalError,
} from "./safe-path.js";
import { domainRootPath } from "./domain.js";
import { listArchiveMembers } from "./archive.js";
import { reapProcessesUnder, describeReaped, type ReapedProcess } from "./process-reaper.js";

// AGENTS.md § Modül 4: "Sadece /var/www/vhosts/domain.com altındaki
// dosyalara erişim ve CRUD imkanı tanıyan, dizin dışına çıkmayı engelleyen
// ultra-güvenli bir File Manager." Kök burada domain'in KENDİ dizini
// (`<domain>/`), Modül 1'in yalnızca `public` alt klasörünü kullanmasından
// farklı — dosya yöneticisi tüm domain ağacını yönetir.

const execFileAsync = promisify(execFile);

export class FileOpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Dosya sistemi hatasini KULLANICIYA ANLAM IFADE EDEN bir FileOpError'a cevirir.
 *
 * NEDEN VAR: bu hatalar daha once hic yakalanmiyordu; ham ENOENT/EACCES
 * Fastify'a kadar gidip ciplak "Internal Server Error" (500) donuyordu.
 * Gercekte yasandi: bir domain dizini root olarak olusturulmustu, panel
 * devuser ile calisiyordu ve her yukleme "Internal Server Error" veriyordu —
 * ne kullanici ne de log gercek sebebi (EACCES) soyluyordu.
 */
export function fsErrorToFileOpError(err: unknown, action: string): FileOpError {
  if (err instanceof FileOpError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return new FileOpError(
        `${action} için izin yok — hedef dizin panel kullanıcısına ait değil. ` +
          "Sunucuda `chown -R` ile sahipliği düzeltin.",
        403,
      );
    case "ENOSPC":
      return new FileOpError(`${action} başarısız: diskte yer kalmadı.`, 507);
    case "EROFS":
      return new FileOpError(`${action} başarısız: dosya sistemi salt okunur.`, 403);
    case "EDQUOT":
      return new FileOpError(`${action} başarısız: disk kotası doldu.`, 507);
    case "ENOENT":
      return new FileOpError(`${action} başarısız: hedef yol bulunamadı.`, 404);
    case "ENOTDIR":
      return new FileOpError(`${action} başarısız: yol üzerinde bir dosya var, klasör değil.`, 400);
    case "EISDIR":
      return new FileOpError(`${action} başarısız: hedef bir klasör.`, 400);
    case "ENAMETOOLONG":
      return new FileOpError(`${action} başarısız: dosya adı çok uzun.`, 400);
    default:
      return new FileOpError(`${action} başarısız (${code ?? "bilinmeyen hata"}).`, 500);
  }
}

export const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MiB — metin editörü sınırı

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
}

async function resolveDomainPath(domainName: string, relPath: string) {
  const root = makeSafeRoot(domainRootPath(domainName));
  let target: string;
  try {
    target = resolveWithinRoot(root, relPath || ".");
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new FileOpError(err.message, 403);
    }
    throw err;
  }
  try {
    await assertNoSymlinkEscape(root, target);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new FileOpError(err.message, 403);
    }
    throw err;
  }
  return { root, target };
}

export async function listDirectory(domainName: string, relPath: string): Promise<FileEntry[]> {
  const { target } = await resolveDomainPath(domainName, relPath);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new FileOpError("Dizin bulunamadı.", 404);
  }
  if (!stat.isDirectory()) {
    throw new FileOpError("Belirtilen yol bir dizin değil.", 400);
  }

  const names = await fs.readdir(target);
  const entries: FileEntry[] = [];
  for (const name of names) {
    const entryStat = await fs.lstat(path.join(target, name));
    entries.push({
      name,
      type: entryStat.isDirectory() ? "directory" : entryStat.isFile() ? "file" : "other",
      size: entryStat.size,
      mtimeMs: entryStat.mtimeMs,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFileContent(domainName: string, relPath: string): Promise<string> {
  const { target } = await resolveDomainPath(domainName, relPath);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new FileOpError("Dosya bulunamadı.", 404);
  }
  if (!stat.isFile()) {
    throw new FileOpError("Belirtilen yol bir dosya değil.", 400);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new FileOpError(`Dosya çok büyük (>${MAX_READ_BYTES} bayt) — indirin.`, 413);
  }
  return fs.readFile(target, "utf8");
}

export async function createEntry(
  domainName: string,
  relPath: string,
  isDirectory: boolean,
  content: string,
): Promise<void> {
  const { target } = await resolveDomainPath(domainName, relPath);
  try {
    await fs.access(target);
    throw new FileOpError("Bu yolda zaten bir dosya/dizin var.", 409);
  } catch (err) {
    if (err instanceof FileOpError) throw err;
    // ENOENT beklenen durum (henüz yok) — devam.
  }
  try {
    if (isDirectory) {
      await fs.mkdir(target, { recursive: true, mode: 0o755 });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.writeFile(target, content, "utf8");
    }
  } catch (err) {
    throw fsErrorToFileOpError(err, isDirectory ? "Klasör oluşturma" : "Dosya oluşturma");
  }
}

export async function updateFileContent(
  domainName: string,
  relPath: string,
  content: string,
): Promise<void> {
  const { target } = await resolveDomainPath(domainName, relPath);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new FileOpError("Dosya bulunamadı.", 404);
  }
  if (!stat.isFile()) {
    throw new FileOpError("Belirtilen yol bir dosya değil.", 400);
  }
  try {
    await fs.writeFile(target, content, "utf8");
  } catch (err) {
    throw fsErrorToFileOpError(err, "Kaydetme");
  }
}

/**
 * Tek dosya için yükleme sınırı.
 *
 * ZİNCİRİN TAMAMI HİZALI OLMAK ZORUNDA. İstek şu üç kapıdan geçiyor ve en dar
 * olan kazanıyor; biri geride kalırsa yükleme, sebebi görünmeyen bir hatayla
 * ölür:
 *   1. nginx  — ops/nginx/studio-panel.conf `client_max_body_size`
 *      (aşılırsa 413, istek API'ye hiç ulaşmaz)
 *   2. Next.js — apps/web/next.config.ts `proxyClientMaxBodySize`
 *      (varsayılanı 10 MB'tı; 2026-08-29'da 500 MB'lık bir yükleme tam burada
 *      "socket hang up / ECONNRESET" ile düşüyordu, ops/web.log'da duruyor)
 *   3. bu sabit — @fastify/multipart `limits.fileSize` (server.ts)
 *
 * Değer ortam değişkeniyle büyütülebilir; varsayılan 2 GB. Sınırı burada
 * değiştirirken 1. ve 2. maddeyi de güncelleyin.
 */
export const MAX_UPLOAD_BYTES = (() => {
  const raw = Number.parseInt(process.env.MAX_UPLOAD_MB ?? "", 10);
  const megabytes = Number.isFinite(raw) && raw > 0 ? raw : 2048;
  return megabytes * 1024 * 1024;
})();

/**
 * Tek istekte kabul edilen azami dosya adedi.
 *
 * Klasör yüklemesi tek seferde yüzlerce dosya gönderir; eski 20'lik sınır
 * @fastify/multipart tarafından SESSİZCE uygulanıyordu (fazlası hiç
 * okunmadan düşüyordu). Sınır burada yükseltildi, ayrıca routes/files.ts
 * istemcinin bildirdiği dosya adedini alınanla karşılaştırıp eksik varsa
 * isteği reddediyor — yarım yüklenmiş bir klasörü "başarılı" saymıyoruz.
 */
export const MAX_UPLOAD_FILES = 500;

/**
 * İstemciden gelen göreli yolu güvenli segmentlere indirger.
 *
 * Klasör yüklemesinde tarayıcı `webkitRelativePath` ile `dist/assets/app.js`
 * gibi bir yol verir; bu yapı KORUNMALI (eski kod `path.basename` uygulayıp
 * tüm ağacı tek klasöre düzleştiriyordu). Güvenlik için:
 *   - `\` ayıracı `/`'a çevrilir (Windows'tan gelen yollar),
 *   - `.` ve `..` segmentleri ile boş segmentler tamamen atılır,
 *   - her segment kendi içinde `path.basename`'e indirgenir.
 * Baştaki noktalar KORUNUR: `.htaccess` / `.env` gerçek dosya adlarıdır ve
 * bozulmaları sessiz veri kaybı olur. `..` zaten segment olarak elenir, kök
 * dışına çıkma denetimini de resolveDomainPath yapar.
 */
export function sanitizeRelativeUploadPath(raw: string): string {
  return String(raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => path.basename(segment.trim()))
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

/**
 * Yüklenen bir dosyayı hedef klasöre yazar.
 *
 * `relativeName` bir ALT YOL içerebilir (`assets/img/logo.png`) — klasör
 * yüklemesi bu sayede ağacı olduğu gibi korur. Ad istemciden geldiği için
 * önce sanitizeRelativeUploadPath'ten, ardından resolveDomainPath'ten
 * geçirilir; ara klasörler oluşturulduktan SONRA symlink denetimi
 * tekrarlanır (yeni açılan bir yol var olan bir symlink'e girmiş olabilir).
 */
export async function saveUploadedFile(
  domainName: string,
  dirRelPath: string,
  relativeName: string,
  data: Buffer,
): Promise<{ name: string; size: number }> {
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    throw new FileOpError(
      `Dosya çok büyük. Sınır ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      413,
    );
  }
  const { safeName, target } = await resolveUploadTarget(domainName, dirRelPath, relativeName);
  try {
    await fs.writeFile(target, data, { mode: 0o644 });
  } catch (err) {
    throw fsErrorToFileOpError(err, `"${safeName}" yazma`);
  }
  return { name: safeName, size: data.byteLength };
}

/**
 * Yükleme hedefini doğrular ve yazmaya hazır mutlak yolu döndürür.
 *
 * saveUploadedFile ve saveUploadedStream'in ORTAK güvenlik yolu. İkisinin
 * ayrı denetim kopyaları olsaydı biri güncellenip öteki geride kalabilirdi;
 * dizin dışına çıkma denetiminin tek bir yerde durması şart.
 */
async function resolveUploadTarget(
  domainName: string,
  dirRelPath: string,
  relativeName: string,
): Promise<{ safeName: string; target: string }> {
  // `..` sanitize ile sessizce düşürülebilirdi ama gerçek bir tarayıcı asla
  // göndermez — geldiyse niyet kötüdür, sessiz düzeltmek yerine reddediyoruz.
  const rawSegments = String(relativeName ?? "").replace(/\\/g, "/").split("/");
  if (rawSegments.some((segment) => segment.trim() === "..")) {
    throw new FileOpError("Dosya yolu dizin dışına çıkmaya çalışıyor.", 403);
  }

  const safeName = sanitizeRelativeUploadPath(relativeName);
  if (!safeName) throw new FileOpError("Geçersiz dosya adı.", 400);

  const { target: dirTarget } = await resolveDomainPath(domainName, dirRelPath || ".");
  let dirStat;
  try {
    dirStat = await fs.stat(dirTarget);
  } catch {
    throw new FileOpError("Hedef klasör bulunamadı.", 404);
  }
  if (!dirStat.isDirectory()) throw new FileOpError("Hedef bir klasör değil.", 400);

  const relTarget = dirRelPath ? `${dirRelPath}/${safeName}` : safeName;
  await resolveDomainPath(domainName, relTarget);
  const { target: parentTarget } = await resolveDomainPath(
    domainName,
    path.posix.dirname(relTarget),
  );
  try {
    await fs.mkdir(parentTarget, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw fsErrorToFileOpError(err, `"${safeName}" için klasör oluşturma`);
  }
  // Ara klasörler oluştuktan sonra yeniden doğrula.
  const { target } = await resolveDomainPath(domainName, relTarget);
  return { safeName, target };
}

/**
 * Yüklenen dosyayı AKITARAK diske yazar — tamamını belleğe almadan.
 *
 * NEDEN GEREKLİ: önceki yol `part.toBuffer()` ile dosyanın tamamını RAM'e
 * alıyordu. 50 MB sınırındayken bu görünmezdi; sınır 2 GB'a çıkınca aynı kod
 * tek bir yüklemede 2 GB RAM ister — konteynerin 14 GB'ı birkaç eşzamanlı
 * yüklemede biter ve süreç OOM ile ölür (yükleme yapan kullanıcı için 502).
 * Akıtma sabit ~64 KB tampon kullanır; dosya boyutu bellek tüketimini
 * etkilemez.
 *
 * `truncated` kontrolü ÇAĞIRANA ait: @fastify/multipart sınırı aşınca akışı
 * sessizce keser, bu fonksiyon da yarım dosyayı diske yazmış olur. Çağıran
 * bayrağı görüp yarım dosyayı silmek zorundadır (bkz. routes/files.ts).
 */
export async function saveUploadedStream(
  domainName: string,
  dirRelPath: string,
  relativeName: string,
  stream: NodeJS.ReadableStream,
): Promise<{ name: string; size: number; absolutePath: string }> {
  const { safeName, target } = await resolveUploadTarget(domainName, dirRelPath, relativeName);
  let written = 0;
  stream.on("data", (chunk: Buffer | string) => {
    written += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
  });
  try {
    await pipeline(stream, createWriteStream(target, { mode: 0o644 }));
  } catch (err) {
    // Yarım kalan dosyayı bırakma: kullanıcı onu "yüklenmiş" sanır.
    await fs.rm(target, { force: true }).catch(() => {});
    throw fsErrorToFileOpError(err, `"${safeName}" yazma`);
  }
  return { name: safeName, size: written, absolutePath: target };
}

/** İndirme için dosyayı doğrular ve mutlak yolunu döndürür. */
export async function resolveDownloadTarget(
  domainName: string,
  relPath: string,
): Promise<{ absolutePath: string; fileName: string; size: number }> {
  const { target } = await resolveDomainPath(domainName, relPath);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new FileOpError("Dosya bulunamadı.", 404);
  }
  if (!stat.isFile()) throw new FileOpError("Yalnızca dosyalar indirilebilir.", 400);
  return { absolutePath: target, fileName: path.basename(target), size: stat.size };
}

export type ArchiveKind = "zip" | "tar.gz";

export function detectArchiveKind(fileName: string): ArchiveKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  return null;
}

/**
 * Arşivi bulunduğu klasöre açar.
 *
 * zip-slip koruması: arşiv AÇILMADAN ÖNCE içindekilerin listesi okunur ve her
 * girdinin hedef kök içinde kaldığı doğrulanır. Tek bir girdi bile dışarı
 * çıkıyorsa hiçbir şey açılmaz — kısmen açılmış bir arşiv bırakmayız.
 */
export async function extractArchive(
  domainName: string,
  relPath: string,
): Promise<{ extracted: number; into: string }> {
  const { root, target } = await resolveDomainPath(domainName, relPath);
  const kind = detectArchiveKind(target);
  if (!kind) {
    throw new FileOpError("Yalnızca .zip, .tar.gz ve .tgz arşivleri açılabilir.", 400);
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new FileOpError("Arşiv bulunamadı.", 404);
  }
  if (!stat.isFile()) throw new FileOpError("Belirtilen yol bir dosya değil.", 400);

  const destination = path.dirname(target);

  let entries: string[];
  try {
    // Üye adları arşivin baytlarından okunur — harici aracın listesinden DEĞİL.
    // Gerekçe için bkz. lib/archive.ts: busybox tar/unzip listelerken bile
    // "../" önekini siliyor ve listeye bakan bir koruma kör kalıyor.
    entries = await listArchiveMembers(kind, target);
  } catch {
    throw new FileOpError("Arşiv okunamadı; dosya bozuk olabilir.", 400);
  }

  for (const entry of entries) {
    if (!entry || entry.endsWith("/")) continue;
    if (path.isAbsolute(entry)) {
      throw new FileOpError(`Arşivde mutlak yol var (${entry}). Açılmadı.`, 403);
    }
    const resolved = path.resolve(destination, entry);
    // Kök dışına çıkan tek bir girdi bile arşivi TÜMDEN reddettirir —
    // yarım açılmış bir arşiv bırakmıyoruz.
    if (resolved !== root.resolved && !resolved.startsWith(root.resolved + path.sep)) {
      throw new FileOpError(
        `Arşiv, domain dizininin dışına yazmaya çalışıyor (${entry}). Açılmadı.`,
        403,
      );
    }
  }

  try {
    if (kind === "zip") {
      // busybox unzip: -o üzerine yaz, -q sessiz, -d hedefi sabitler.
      await execFileAsync("unzip", ["-o", "-q", target, "-d", destination]);
    } else {
      await execFileAsync("tar", ["-xzf", target, "-C", destination]);
    }
  } catch (err) {
    // Aracın stderr'i gerçek sebebi taşır (izin, bozuk arşiv, disk dolu);
    // ham hatayı 500'e düşürmek yerine kullanıcıya geçiriyoruz.
    const detail = String((err as { stderr?: string }).stderr ?? "").trim().slice(0, 300);
    throw new FileOpError(
      `Arşiv açılamadı${detail ? `: ${detail}` : "."} Hedef klasörün yazma izni olduğundan emin olun.`,
      500,
    );
  }

  return { extracted: entries.filter((e) => e && !e.endsWith("/")).length, into: destination };
}

/**
 * Dosya/klasörü diskten KALICI olarak siler (çöp kutusu yok).
 *
 * Eski sürüm `fs.rm`'in HER hatasını 404 "bulunamadı"ya çeviriyordu; izin
 * hatası (EACCES/EPERM) ya da dolu bir dizin de "bulunamadı" görünüyor,
 * yani dosya diskte DURUYORKEN kullanıcıya yanlış sebep bildiriliyordu.
 * Artık errno ayrıştırılıyor ve silme sonrası yolun gerçekten kaybolduğu
 * `lstat` ile doğrulanıyor — "sildim ama duruyor" durumu sessiz geçmez.
 */
export async function deleteEntry(domainName: string, relPath: string): Promise<ReapedProcess[]> {
  const { root, target } = await resolveDomainPath(domainName, relPath);
  if (target === root.resolved) {
    // Domain'in KÖK dizini dosya yöneticisiyle silinemez — bu Modül 1'in
    // onay gerektiren domain-silme akışına ait (guard.json: /var/www/vhosts/).
    throw new FileOpError(
      "Domain kök dizini dosya yöneticisiyle silinemez; domain'i silmek için /api/domains/:id kullanın.",
      400,
    );
  }

  // lstat: symlink'in KENDİSİ silinebilmeli, hedefi çözülmemeli.
  try {
    await fs.lstat(target);
  } catch {
    throw new FileOpError("Dosya/dizin bulunamadı.", 404);
  }

  // SİLMEDEN ÖNCE: bu yoldan çalışan süreçleri durdur.
  //
  // Linux'ta bir dosyayı silmek, onu açık tutan süreci durdurmaz; inode
  // canlı kalır (`/proc/<pid>/cwd -> ... (deleted)`). Bir vhost'ta bu,
  // klasör diskten tamamen gittiği hâlde sitenin tarayıcıda açılmaya devam
  // etmesi demekti (2026-09-07; ayrıntılı gerekçe process-reaper.ts'te).
  // Sıra kritik: önce silip sonra öldürmek, arada doğan süreçlerin silinmiş
  // inode'u canlı tutmasına izin verirdi.
  const reaped = await reapProcessesUnder(target);
  const survivors = reaped.filter((r) => r.outcome === "failed");
  if (survivors.length > 0) {
    // Burada SİLMİYORUZ. Silseydik dosya listeden kaybolur ama site ayakta
    // kalırdı — kullanıcının gördüğü tam olarak buydu ve sebebi anlaşılmıyordu.
    throw new FileOpError(
      `Silinmedi: bu yolu kullanan süreç durdurulamadı (${describeReaped(survivors)}). ` +
        "Süreç panel kullanıcısına ait değil; sunucuda root olarak durdurulmalı.",
      409,
    );
  }

  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EBUSY") {
      throw new FileOpError("Dosya kullanımda olduğu için silinemedi.", 409);
    }
    throw fsErrorToFileOpError(err, "Silme");
  }

  // Gerçekten gitti mi? fs.rm sessizce başarısız olabildiği durumlar için
  // (ör. ağ/overlay dosya sistemleri) son bir doğrulama.
  let stillThere = true;
  try {
    await fs.lstat(target);
  } catch {
    stillThere = false;
  }
  if (stillThere) {
    throw new FileOpError("Silme tamamlanamadı; dosya hâlâ diskte.", 500);
  }

  return reaped;
}

export interface BulkDeleteResult {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
  /** Silme sırasında durdurulan süreçler — kullanıcıya "site neden hâlâ açıktı"nın cevabı. */
  reaped: ReapedProcess[];
}

/**
 * Çoklu silme. Tek tek silinir; biri patlarsa diğerleri denenmeye devam eder
 * ve hangisinin neden silinemediği tek tek raporlanır — 20 dosyalık bir
 * seçimde tek hata yüzünden hiçbirinin silinmemesi daha kötü olurdu.
 */
export async function deleteEntries(
  domainName: string,
  relPaths: string[],
): Promise<BulkDeleteResult> {
  const result: BulkDeleteResult = { deleted: [], failed: [], reaped: [] };
  for (const relPath of relPaths) {
    try {
      result.reaped.push(...(await deleteEntry(domainName, relPath)));
      result.deleted.push(relPath);
    } catch (err) {
      result.failed.push({
        path: relPath,
        error: err instanceof FileOpError ? err.message : "Silinemedi.",
      });
    }
  }
  return result;
}

export async function renameEntry(domainName: string, fromPath: string, toPath: string): Promise<void> {
  const { root, target: fromTarget } = await resolveDomainPath(domainName, fromPath);
  const { target: toTarget } = await resolveDomainPath(domainName, toPath);
  if (fromTarget === root.resolved) {
    throw new FileOpError("Domain kök dizini yeniden adlandırılamaz.", 400);
  }
  try {
    await fs.access(fromTarget);
  } catch {
    throw new FileOpError("Kaynak dosya/dizin bulunamadı.", 404);
  }
  try {
    await fs.access(toTarget);
    throw new FileOpError("Hedef yolda zaten bir dosya/dizin var.", 409);
  } catch (err) {
    if (err instanceof FileOpError) throw err;
  }
  try {
    await fs.mkdir(path.dirname(toTarget), { recursive: true, mode: 0o755 });
    await fs.rename(fromTarget, toTarget);
  } catch (err) {
    throw fsErrorToFileOpError(err, "Yeniden adlandırma");
  }
}
