import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsSync from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../env.js";
import { maildirPath } from "./mail.js";

const execFileAsync = promisify(execFile);

/**
 * Posta kutusu doluluk olcumu ve webmail adresi.
 *
 * NEDEN `du`, IMAP QUOTA DEGIL: dovecot'un QUOTA eklentisi kullanimi biliyor
 * ama onu sormak KULLANICININ PAROLASIYLA IMAP'e giris yapmayi gerektirir.
 * Panelde admin, musterinin parolasini bilmez (ve bilmemeli). Maildir zaten
 * `<domain kokü>/mail/<localPart>` altinda ve panel o agacin sahibi; diskten
 * olcmek hem dogru hem de kimlik gerektirmeyen tek yol. Plesk de posta kutusu
 * boyutunu ayni sekilde gosterir.
 */

/** `du` pahali; panel acikken her yenilemede yeniden gezilmesin. */
const CACHE_TTL_MS = 120_000;
const MEASURE_TIMEOUT_MS = 15_000;

interface CacheEntry {
  bytes: number | null;
  at: number;
  error?: string;
}

const cache = new Map<string, CacheEntry>();

/** Test ve "yenile" icin. */
export function clearMailUsageCache(): void {
  cache.clear();
}

export interface MailboxUsage {
  /** Diskte kaplanan bayt. Olculemediyse null. */
  bytes: number | null;
  /** Posta kutusu dizini henuz yoksa true (hic mail gelmemis); bytes 0. */
  missing: boolean;
  error?: string;
}

async function measure(domainName: string, localPart: string): Promise<CacheEntry> {
  const now = Date.now();
  const dir = maildirPath(domainName, localPart);
  if (!fsSync.existsSync(dir)) return { bytes: 0, at: now };
  try {
    // -sk: DISKTE KAPLANAN blok alani (kibibayt). Kota da diskte kaplanan
    // alana gore uygulanir; gorunur boyut (-sb) burada yaniltici olurdu.
    const { stdout } = await execFileAsync("du", ["-sk", dir], {
      timeout: MEASURE_TIMEOUT_MS,
      maxBuffer: 1024 * 64,
    });
    const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    if (!Number.isFinite(kib)) return { bytes: null, at: now, error: "du çıktısı okunamadı." };
    return { bytes: kib * 1024, at: now };
  } catch (err) {
    const e = err as { killed?: boolean; message?: string };
    return {
      bytes: null,
      at: now,
      error: e.killed ? "Ölçüm zaman aşımına uğradı." : `Ölçülemedi: ${e.message ?? "bilinmeyen hata"}`,
    };
  }
}

/**
 * Bir domainin posta kutusu kullanimlarini olcer. Sira korunur.
 *
 * Es zamanlilik 2: `du` CPU degil DISK bagimli; hepsini paralel baslatmak
 * konteynerin I/O'sunu doyurup canli siteleri yavaslatir (ayni gerekce
 * lib/disk-usage.ts icinde).
 */
export async function mailboxUsages(
  domainName: string,
  localParts: string[],
  options: { refresh?: boolean } = {},
): Promise<MailboxUsage[]> {
  const results: MailboxUsage[] = new Array(localParts.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= localParts.length) return;
      const localPart = localParts[index];
      const key = `${domainName}/${localPart}`;
      const cached = cache.get(key);
      const entry =
        options.refresh !== true && cached && Date.now() - cached.at < CACHE_TTL_MS
          ? cached
          : await measure(domainName, localPart).then((fresh) => {
              cache.set(key, fresh);
              return fresh;
            });
      results[index] = {
        bytes: entry.bytes,
        missing: entry.bytes === 0 && !fsSync.existsSync(maildirPath(domainName, localPart)),
        ...(entry.error ? { error: entry.error } : {}),
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, localParts.length) }, () => worker()));
  return results;
}

/**
 * Bu domainin webmail adresi — DOGRU SEMAYLA.
 *
 * NEDEN SEMAYI KONTROL EDIYORUZ: webmail her `webmail.<domain>` adi icin
 * calisir ama HTTPS ancak o ad icin sertifika alinmissa (ops/scripts/
 * webmail-ssl.sh) vardir. Kosulsuz `https://` vermek, sertifikasi olmayan
 * domainlerde kullaniciyi tarayici guvenlik uyarisina gonderirdi — panelin
 * verdigi bir baglantinin bunu yapmasi kabul edilemez. Sertifika yoksa
 * `http://` veriyoruz: calisir ve yalan soylemez.
 *
 * NEDEN SERTIFIKA DOSYASINA DEGIL NGINX CONFIG'INE BAKIYORUZ:
 *   1. /etc/letsencrypt/live 0700 root'tur; panel (devuser) oraya bakamaz ve
 *      `existsSync` IZIN HATASINDA DA false doner — yani sertifika VARKEN
 *      "yok" derdi. (Ayni tuzak bu projede DKIM anahtarinda da yasandi.)
 *   2. Daha da onemlisi, config dosyasinin varligi DAHA DOGRU bir sinyal:
 *      webmail-ssl.sh onu ancak sertifika alindiktan VE `nginx -t` gectikten
 *      sonra yaziyor. Yani "sertifika bir yerde duruyor" degil, "HTTPS
 *      gercekten yayinda" demek.
 */
const WEBMAIL_SSL_CONF_DIR = "/etc/nginx/conf.d";

export function webmailHasHttps(domainName: string): boolean {
  return fsSync.existsSync(path.join(WEBMAIL_SSL_CONF_DIR, `webmail-ssl.${domainName}.conf`));
}

export function webmailUrl(domainName: string): string {
  return `${webmailHasHttps(domainName) ? "https" : "http"}://webmail.${domainName}`;
}
