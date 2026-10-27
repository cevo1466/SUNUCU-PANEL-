// Klasör yükleme yardımcıları.
//
// Tarayıcı iki farklı yoldan klasör verir ve ikisi de düz `File[]` değildir:
//   1. <input type="file" webkitdirectory> → her File'da `webkitRelativePath`
//      dolu gelir ("dist/assets/app.js").
//   2. Sürükle-bırak → `DataTransfer.files` klasörleri HİÇ vermez (ya boş ya
//      da 0 baytlık sahte bir girdi). Ağacı okumanın tek yolu
//      `DataTransferItem.webkitGetAsEntry()` ile FileSystem API'sini
//      dolaşmaktır. Panelde klasör bırakınca hiçbir şey olmamasının sebebi
//      buydu.
//
// Her iki yol da aynı `UploadItem[]` biçimine indirgenir: dosya + hedefe
// göre göreli yol. Göreli yolu sunucu koruyarak yazar.

import type { UploadItem } from "./api";

// Minimal FileSystem API tipleri — lib.dom bunları yalnızca kısmen tanıyor.
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FsFileEntry extends FsEntry {
  file(onSuccess: (file: File) => void, onError: (err: unknown) => void): void;
}
interface FsDirectoryReader {
  readEntries(onSuccess: (entries: FsEntry[]) => void, onError: (err: unknown) => void): void;
}
interface FsDirectoryEntry extends FsEntry {
  createReader(): FsDirectoryReader;
}

function entryFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** readEntries tek seferde en fazla 100 girdi döner — bitene kadar çağrılır. */
function readAllEntries(reader: FsDirectoryReader): Promise<FsEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FsEntry[] = [];
    const step = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        step();
      }, reject);
    };
    step();
  });
}

async function walkEntry(entry: FsEntry, prefix: string, out: UploadItem[]): Promise<void> {
  const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ file: await entryFile(entry as FsFileEntry), relPath });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAllEntries((entry as FsDirectoryEntry).createReader());
  for (const child of children) {
    await walkEntry(child, relPath, out);
  }
}

/**
 * Sürüklenip bırakılan içeriği (dosya ve/veya klasör ağacı) düz listeye açar.
 *
 * `webkitGetAsEntry()` SENKRON çağrılmalı: ilk `await`'ten sonra
 * `DataTransferItemList` boşalır. Bu yüzden girdiler önce toplanır, ağaç
 * sonra gezilir.
 */
export async function itemsFromDataTransfer(dataTransfer: DataTransfer): Promise<UploadItem[]> {
  const roots: FsEntry[] = [];
  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null })
        .webkitGetAsEntry?.();
      if (entry) roots.push(entry);
    }
  }

  if (roots.length === 0) {
    // FileSystem API yok (eski tarayıcı) — klasörsüz düz dosya listesi.
    return Array.from(dataTransfer.files).map((file) => ({ file, relPath: file.name }));
  }

  const out: UploadItem[] = [];
  for (const root of roots) {
    await walkEntry(root, "", out);
  }
  return out;
}

/** <input type="file"> (klasör seçimi dahil) çıktısını UploadItem'a çevirir. */
export function itemsFromFileList(files: FileList | File[]): UploadItem[] {
  return Array.from(files).map((file) => ({
    file,
    // webkitdirectory ile seçildiğinde klasör yolu buradadır.
    relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

/**
 * İstek başına gövde bütçesi.
 *
 * Sunucu zincirinin sınırı 2 GB (nginx client_max_body_size / Next.js
 * middlewareClientMaxBodySize / API MAX_UPLOAD_BYTES). Burada ondan BİLEREK
 * daha düşük duruluyor: bütçe tek bir isteğin ne kadar süreceğini belirler ve
 * bir istek koparsa o isteğin TAMAMI baştan gider. 256 MB'lık parçalar, bir
 * kopmada en fazla o kadarını tekrarlatır.
 *
 * Bu sınır tek bir dosyayı BÖLMEZ; bütçeden büyük tek dosya kendi isteğinde
 * tek başına gider (chunkUploads bunu zaten yapıyor) ve o dosya için geçerli
 * olan sınır sunucudaki 2 GB'tır.
 */
export const BATCH_MAX_BYTES = 256 * 1024 * 1024;
/** Sunucu sınırı 500; altında kalıp güvenli tarafta duruyoruz. */
export const BATCH_MAX_FILES = 200;

/**
 * Yüklemeyi isteklere böler. Tek bir istek Nginx'in gövde sınırını aşarsa
 * yükleme 413 ile ölürdü; klasör yüklemesi bu yüzden parça parça gider.
 */
export function chunkUploads(items: UploadItem[]): UploadItem[][] {
  const batches: UploadItem[][] = [];
  let current: UploadItem[] = [];
  let currentBytes = 0;

  for (const item of items) {
    if (
      current.length > 0 &&
      (current.length >= BATCH_MAX_FILES || currentBytes + item.file.size > BATCH_MAX_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Genel yükleme ilerlemesi — bayt cinsinden, DOSYA baytı biriminde.
 *
 * NEDEN SAF BIR FONKSIYON: burada kolay yapılan ve sessizce yanlış sonuç veren
 * bir hata var; test edilebilir olması gerekiyor (bkz. self-test).
 *
 * TUZAK: XHR'ın `upload.onprogress` olayı GÖVDE baytını bildirir — yani
 * multipart zarfını da sayar: her dosya için sınır satırı, Content-Disposition
 * başlığı, ayrıca `path`/`count`/`relpath` alanları. Bu ek yük küçük dosyalarda
 * içeriğin KAT KAT üstüne çıkar: 300 adet ~24 baytlık dosya ölçüldüğünde
 * dosyaların toplamı 7.090 bayt iken gerçek gövde 83.930 bayttı (%1083 ek yük).
 *
 * `loaded`'ı doğrudan dosya baytlarıyla karşılaştırmak bu yüzden yanlıştır:
 * çubuk gerçek transferin ~%8'inde %100'e ulaşıp orada donuyordu — kullanıcının
 * ilerleme göstergesi isteme sebebinin ta kendisi.
 *
 * DOĞRUSU: oran, isteğin KENDİ içinde alınır (`loaded/total` — ikisi de gövde
 * baytı, birimler tutarlı), sonra o paketin toplam iş içindeki payıyla
 * ölçeklenir. Böylece paket sınırlarında birim karışması da olmaz.
 */
export function overallUploadedBytes(input: {
  /** Tamamlanmış paketlerin dosya baytı toplamı. */
  completedFileBytes: number;
  /** Süren paketin dosya baytı toplamı. */
  batchFileBytes: number;
  /** Süren pakette gönderilen GÖVDE baytı. */
  batchLoaded: number;
  /** Süren paketin toplam GÖVDE baytı. */
  batchTotal: number;
  /** Yüklemenin tamamının dosya baytı. */
  totalFileBytes: number;
}): number {
  const { completedFileBytes, batchFileBytes, batchLoaded, batchTotal, totalFileBytes } = input;
  // batchTotal 0 olamaz ama tarayıcı bildirmezse payı 0 kabul et: uydurma
  // ilerleme göstermektense çubuk kıpırdamasın.
  const ratio = batchTotal > 0 ? Math.min(1, Math.max(0, batchLoaded / batchTotal)) : 0;
  const loaded = completedFileBytes + batchFileBytes * ratio;
  return Math.min(Math.max(0, loaded), totalFileBytes);
}

const ARCHIVE_PATTERN = /\.(zip|tgz)$|\.tar\.gz$/i;

/** Dosya adı panelin açabildiği bir arşiv mi? (backend: lib/files.ts) */
export function isArchiveName(name: string): boolean {
  return ARCHIVE_PATTERN.test(name);
}
