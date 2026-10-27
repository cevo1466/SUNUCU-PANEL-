import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../env.js";
import { assertValidDomainName } from "./domain.js";

/**
 * Yedeklerin nerede durdugu.
 *
 * NEDEN VHOSTS_ROOT DEGIL: eski yedekleme `<domain>.tar.gz` dosyasini
 * /var/www/vhosts altina yaziyordu — yani korudugu verinin yanina. Uc sorun:
 *   1. Dosya yoneticisinin ve `du` disk olcumunun icine karisiyordu (bir
 *      domainin "disk kullanimi" kendi yedegini de sayiyordu),
 *   2. yedek, koruduğu diskin kaybinda birlikte gidiyordu,
 *   3. domain silinirken yedegi de siliniyordu (routes/domains.ts) — yani
 *      "yanlislikla sildim" senaryosunda geri donus yolu yok ediliyordu.
 * Artik ayri bir agacta: ops/backups/<domain>/
 */
export const BACKUP_ROOT = path.join(PROJECT_ROOT, "ops", "backups");

export interface StoredBackup {
  /** Dosya adi (dizin degil): 2026-09-01T05-30-00Z.tar.gz */
  name: string;
  /** Tam yol. */
  absolutePath: string;
  /** Manifest dosyasinin tam yolu (arsivi acmadan okunabilsin diye yanda). */
  manifestPath: string;
  sizeBytes: number;
  createdAtMs: number;
}

/**
 * Yedek hedefi arayuzu.
 *
 * BUGUN YALNIZCA LocalTarget UYGULANIYOR. Dis kopya (scp / S3-uyumlu) sonradan
 * bu arayuzu uygulayacak; bugun ek tasiyici YAZILMIYOR (kullanici karari:
 * once yerel surumlu kopya). Arayuzun simdiden var olmasinin sebebi, yedek
 * alma kodunun "dosya yoluna yaz" varsayimini her yere dagitmasini onlemek —
 * dagilirsa dis kopya eklemek her dosyaya dokunmak demek olurdu.
 */
export interface BackupTarget {
  put(domainName: string, archiveTmpPath: string, manifest: unknown, finalName: string): Promise<StoredBackup>;
  list(domainName: string): Promise<StoredBackup[]>;
  resolve(domainName: string, name: string): Promise<StoredBackup | null>;
  remove(domainName: string, name: string): Promise<void>;
}

function domainDir(domainName: string): string {
  assertValidDomainName(domainName);
  return path.join(BACKUP_ROOT, domainName);
}

/** Arsiv adi: zaman damgasi. Dosya sisteminde ':' sorunlu, '-' ile degistirildi. */
export function backupNameForNow(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}.tar.gz`;
}

function manifestPathFor(archivePath: string): string {
  return archivePath.replace(/\.tar\.gz$/, ".manifest.json");
}

export const localTarget: BackupTarget = {
  /**
   * Gecici dosyayi kalici ada TASIR.
   *
   * ATOMIKLIK BURADA: arsiv once `.tmp` olarak yazilir, bu fonksiyon onu
   * `rename` ile yerine koyar. rename ayni dosya sisteminde atomiktir; yani
   * yarim yazilmis bir arsiv ASLA gecerli bir yedek adi tasimaz.
   *
   * Eski kod dogrudan hedefe yaziyordu ve `tar` basarisiz olursa yarim dosya
   * orada kaliyordu — dahasi ad SABIT oldugu icin o yarim dosya CALISAN
   * yedegin uzerine yazilmis oluyordu. Yani basarisiz bir yedekleme, elindeki
   * saglam yedegi yok ediyordu.
   */
  async put(domainName, archiveTmpPath, manifest, finalName) {
    const dir = domainDir(domainName);
    await fs.mkdir(dir, { recursive: true, mode: 0o750 });
    const finalPath = path.join(dir, finalName);
    await fs.rename(archiveTmpPath, finalPath);
    const manifestPath = manifestPathFor(finalPath);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o640 });
    const stat = await fs.stat(finalPath);
    return {
      name: finalName,
      absolutePath: finalPath,
      manifestPath,
      sizeBytes: stat.size,
      createdAtMs: stat.mtimeMs,
    };
  },

  async list(domainName) {
    const dir = domainDir(domainName);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: StoredBackup[] = [];
    for (const name of entries) {
      if (!name.endsWith(".tar.gz")) continue;
      const absolutePath = path.join(dir, name);
      try {
        const stat = await fs.stat(absolutePath);
        out.push({
          name,
          absolutePath,
          manifestPath: manifestPathFor(absolutePath),
          sizeBytes: stat.size,
          createdAtMs: stat.mtimeMs,
        });
      } catch {
        /* yaris: dosya silinmis olabilir */
      }
    }
    // EN YENI ONCE — ADA GORE, mtime'a gore DEGIL.
    //
    // NEDEN: arsiv adi zaten ISO zaman damgasi tasiyor
    // (2026-09-01T07-42-43Z.tar.gz) ve ISO damgalar sozlukte siralandiginda
    // kronolojik sirayi verir. mtime ise dosyaya dokunan her sey tarafindan
    // degistirilebilir (kopyalama, tasima, kurtarma) ve o an sira YALAN
    // SOYLER. Rotasyon "en eskiyi sil" derken buna guveniyor; yanlis sira,
    // yanlis yedegi silmek demektir.
    // (Self-test bunu yakaladi: hizlica uretilen bes dosyanin mtime'i ayni
    // cikinca sira bozuldu.)
    return out.sort((a, b) => b.name.localeCompare(a.name));
  },

  async resolve(domainName, name) {
    // Ad istemciden gelebilir; yol ayiraci ASLA kabul edilmez.
    if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
    const list = await this.list(domainName);
    return list.find((b) => b.name === name) ?? null;
  },

  async remove(domainName, name) {
    const found = await this.resolve(domainName, name);
    if (!found) return;
    await fs.rm(found.absolutePath, { force: true });
    await fs.rm(found.manifestPath, { force: true });
  },
};

/** Bos alan (bayt). Yedek oncesi kontrol icin. */
export function freeBytes(onPath: string = BACKUP_ROOT): number | null {
  try {
    const target = fsSync.existsSync(onPath) ? onPath : PROJECT_ROOT;
    const stat = fsSync.statfsSync(target);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // Olculemiyorsa null doner; cagiran "bilmiyorum" ile "yeterli" arasindaki
    // farki koruyabilsin diye false DONMUYORUZ.
    return null;
  }
}

/**
 * Rotasyon: en yeni `keep` adet yedegi birakir, gerisini siler.
 *
 * IKI KURAL:
 *  1. Sayidan bagimsiz olarak, SON DOGRULANMIS yedek ASLA silinmez.
 *     Dogrulanmis yedek, geri yuklenebildigi KANITLANMIS tek kopyadir;
 *     onu "sirasi geldi" diye silmek, elde kanitlanmis hicbir sey
 *     birakmamak demektir.
 *  2. Silme, en ESKIDEN baslar.
 *
 * @param verifiedNames Dogrulamasi gecmis arsiv adlari (backup_runs'tan).
 */
export async function rotateBackups(
  domainName: string,
  keep: number,
  verifiedNames: Set<string>,
): Promise<string[]> {
  const list = await localTarget.list(domainName); // en yeni once
  if (list.length <= keep) return [];

  const removed: string[] = [];
  // Silme adaylari: en eskiden baslayarak, keep sinirini asanlar.
  const candidates = list.slice(keep).reverse();
  // Korunacak dogrulanmis yedek: adaylar arasindaki EN YENI dogrulanmis olan.
  // (Sinir icindekiler zaten korunuyor.)
  const protectedName = list.slice(keep).find((b) => verifiedNames.has(b.name))?.name;

  for (const candidate of candidates) {
    if (candidate.name === protectedName) continue;
    await localTarget.remove(domainName, candidate.name);
    removed.push(candidate.name);
  }
  return removed;
}
