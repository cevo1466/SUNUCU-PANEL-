import fs from "node:fs/promises";
import zlib from "node:zlib";

/**
 * Arşiv üye adlarını ARŞİVİN BAYTLARINDAN okur.
 *
 * Neden harici araca güvenmiyoruz: bu konteynerdeki busybox `tar` ve `unzip`,
 * listeleme sırasında bile üye adının başındaki `../` önekini sessizce siliyor
 * ("removing leading '../../../' from member names"). Yani `tar -tzf` çıktısına
 * bakan bir zip-slip koruması, gerçek üye `../../../etc/x` iken `etc/x` görür ve
 * arşivi güvenli sanır. Üstelik busybox `unzip` `-Z1` bayrağını hiç tanımıyor.
 *
 * Bu yüzden adlar burada elle ayrıştırılıyor: güvenlik kararı yalnızca
 * arşivin kendi baytlarına dayanıyor.
 */

const TAR_BLOCK = 512;

function readNulString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(buffer: Buffer, start: number, length: number): number {
  const text = readNulString(buffer, start, length).trim();
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** gzip'lenmiş tar içindeki üye adları. */
export function listTarGzMembers(gzipped: Buffer): string[] {
  const tar = zlib.gunzipSync(gzipped);
  const names: string[] = [];

  for (let offset = 0; offset + TAR_BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    // İki ardışık boş blok arşivin sonudur.
    if (header.every((byte) => byte === 0)) break;

    const name = readNulString(header, 0, 100);
    const prefix = readNulString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);

    if (name) names.push(prefix ? `${prefix}/${name}` : name);

    // GNU uzun-ad girdisi ('L'): adı bir sonraki veri bloğunda taşır.
    if (typeflag === "L") {
      const longName = readNulString(tar, offset + TAR_BLOCK, size);
      if (longName) names.push(longName);
    }

    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }

  return names;
}

/** ZIP merkezi dizininden üye adları. */
export function listZipMembers(zip: Buffer): string[] {
  // End of Central Directory imzasını sondan geriye doğru ara (yorum alanı
  // 64 KB'a kadar olabilir).
  const EOCD_SIGNATURE = 0x06054b50;
  let eocd = -1;
  const searchFrom = Math.max(0, zip.length - 66_000);
  for (let i = zip.length - 22; i >= searchFrom; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("ZIP merkezi dizini bulunamadı.");

  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > zip.length) break;
    if (zip.readUInt32LE(offset) !== 0x02014b50) break;

    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);

    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

export async function listArchiveMembers(
  kind: "zip" | "tar.gz",
  archivePath: string,
): Promise<string[]> {
  const buffer = await fs.readFile(archivePath);
  return kind === "zip" ? listZipMembers(buffer) : listTarGzMembers(buffer);
}
