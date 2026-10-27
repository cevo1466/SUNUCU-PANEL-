import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// Kök: apps/api/src -> apps/api -> apps -> <proje kökü>
const projectRoot = path.resolve(here, "..", "..", "..");
dotenv.config({ path: path.join(projectRoot, ".env.loopkit") });

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function required(name: string, fallback?: string): string {
  const v = optional(name) ?? fallback;
  if (!v) throw new Error(`Eksik ortam değişkeni: ${name}`);
  return v;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = optional(name);
  return value === undefined ? fallback : value.toLowerCase() === "true";
}

/**
 * Sayisal ortam degiskeni. Gecersiz/eksik deger sessizce varsayilana duser —
 * bir yazim hatasi yuzunden alarm esiginin NaN olmasi, alarmlarin sessizce
 * hic calismamasi demek olurdu.
 */
function number(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const PROJECT_ROOT = projectRoot;

export const env = {
  PORT: Number(optional("API_PORT") ?? 3001),
  DATABASE_URL: required(
    "DATABASE_URL",
    "postgres://studio:studio@127.0.0.1:5433/studio_panel",
  ),
  SESSION_SECRET: required(
    "SESSION_SECRET",
    "dev-only-insecure-secret-change-me-32chars!",
  ),
  HETRIX_API_KEY: optional("HETRIX_API_KEY"),
  CLOUDFLARE_API_TOKEN: optional("CLOUDFLARE_API_TOKEN"),
  // Testte gerçek api.cloudflare.com yerine yerel bir mock sunucuya
  // yönlendirmek için (bkz. lib/cloudflare.ts self-test'i). Prod'da hiç
  // set edilmez, gerçek Cloudflare API'si kullanılır.
  CLOUDFLARE_API_BASE: optional("CLOUDFLARE_API_BASE") ?? "https://api.cloudflare.com/client/v4",
  VHOSTS_ROOT: optional("VHOSTS_ROOT") ?? "/var/www/vhosts",
  // Yeni kullanıcı kabulü kapalıdır. Self-test bunu package script üzerinden
  // açıkça etkinleştirir; çalışan panel hiçbir zaman public kayıt açmaz.
  ALLOW_PUBLIC_REGISTRATION: boolean("ALLOW_PUBLIC_REGISTRATION", false),
  OWNER_EMAIL: optional("PANEL_OWNER_EMAIL") ?? "admin@studiopanel.local",
  // Adminer (tek dosyalık DB yönetim arayüzü) kuruluysa panelin "Yönetim
  // panelini aç" linki buraya gider — bkz. ops/scripts/install-adminer.sh ve
  // PROD-DEPLOYMENT.md. Tanımlı değilse link gösterilmez.
  ADMINER_URL: optional("ADMINER_URL"),
  // Telegram uyarıları (uptime down/up, kaynak limiti aşımı) — bkz.
  // lib/telegram.ts, lib/alerts.ts. İkisi de tanımlı değilse uyarı izleyici
  // sessizce devre dışı kalır, sahte bir "aktif" izlenimi vermez.
  TELEGRAM_BOT_TOKEN: optional("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_CHAT_ID: optional("TELEGRAM_CHAT_ID"),
  // --- Uyari esikleri (bkz. lib/alerts.ts) ---
  // Hepsi kod sabitiydi; operatorun yeniden derlemeden ayarlayabilmesi icin
  // ortama tasindi. Varsayilanlar eski davranisla ayni degil — bilincli
  // olarak cok daha sessiz (kullanicinin "zirt pirt bildirim" sikayeti).
  //
  // Monitor kesintisiz bu kadar dakika "down" kalmadan HICBIR mesaj gitmez.
  // Tek tek basarisiz kontroller (5 sn timeout'a takilan SSH yoklamasi gibi)
  // boylece hic bildirilmez.
  ALERT_DOWN_AFTER_MINUTES: number("ALERT_DOWN_AFTER_MINUTES", 5),
  // Bildirilmis bir kesintiden sonra "RESOLVED" mesaji icin gereken
  // KESINTISIZ ayakta kalma suresi (dk). Duzelir duzelmez degil, gercekten
  // stabillestiginde bildirir — tek bir up/down titremesi RESOLVED'i
  // erken tetiklemesin diye (bkz. lib/uptime-policy.ts).
  ALERT_RESOLVE_AFTER_MINUTES: number("ALERT_RESOLVE_AFTER_MINUTES", 3),
  // Down durumu SURUYORKEN, ilk bildirimden sonra kac dakikada bir "hala
  // down" ozet mesaji gonderilir. 0 = ozet tamamen kapali.
  ALERT_STILL_DOWN_SUMMARY_MINUTES: number("ALERT_STILL_DOWN_SUMMARY_MINUTES", 30),
  // Yerel servis saglik kontrolleri (web/edge-nginx/db) icin down esigi —
  // supervise.sh zaten 2 sn'de bir yeniden baslatmayi DENER, bu yuzden
  // dis (Hetrix) esiginden daha kisa: birkaç dakika sonra hala saglıksızsa
  // gercek bir crash-loop var demektir.
  ALERT_LOCAL_DOWN_AFTER_MINUTES: number("ALERT_LOCAL_DOWN_AFTER_MINUTES", 2),
  // Uptime yuzdesi bu esigin altina duserse TEK bir uyari gonderilir.
  ALERT_UPTIME_PERCENT_MIN: number("ALERT_UPTIME_PERCENT_MIN", 99.5),
  ALERT_MEM_PERCENT: number("ALERT_MEM_PERCENT", 92),
  // Bellek esigi kac dakika kesintisiz asilirsa uyarilir.
  ALERT_MEM_SUSTAIN_MINUTES: number("ALERT_MEM_SUSTAIN_MINUTES", 3),
  ALERT_DISK_PERCENT: number("ALERT_DISK_PERCENT", 90),
  // Disk yavas dolar, titreme riski yok — kisa bir sure yeterli.
  ALERT_DISK_SUSTAIN_MINUTES: number("ALERT_DISK_SUSTAIN_MINUTES", 1),
  // CPU: throttle ORANI degil DOGRUDAN KULLANIM YUZDESI (kullanici talebi,
  // bkz. MEMORY.md 2026-08-28). Anlik %100 sivrilmeler onemsiz; onemli olan
  // kesintisiz yuksek kullanim.
  ALERT_CPU_PERCENT: number("ALERT_CPU_PERCENT", 90),
  ALERT_CPU_SUSTAIN_MINUTES: number("ALERT_CPU_SUSTAIN_MINUTES", 5),
  // Hetrix zaten dakikada bir kontrol ediyor; 30 sn'de bir sormanin kazanci
  // yok, gunde 2880 yerine 1440 istek.
  ALERT_CHECK_INTERVAL_SEC: number("ALERT_CHECK_INTERVAL_SEC", 60),
  // Sunucunun kendi (Cloudflare dışı) otoriter DNS'i için — bkz.
  // lib/localDns.ts, ops/scripts/deploy-zone.sh. Tanımlı değilse zone
  // üretilebilir ama SOA/NS satırları placeholder kalır; panel bunu uyarır.
  DNS_PRIMARY_NS: optional("DNS_PRIMARY_NS"),
  DNS_SECONDARY_NS: optional("DNS_SECONDARY_NS"),
  DNS_HOSTMASTER_EMAIL: optional("DNS_HOSTMASTER_EMAIL"),
  // Panelin "bu sunucuya yönlendir" tek-tık A kaydı butonu için sunucunun
  // kendi genel IP'si. Otomatik keşfedilmiyor — NAT/çoklu arayüz durumunda
  // yanlış IP'yi otomatik yazmak canlı bir domaini yanlış sunucuya
  // yönlendirebilir; operatör bir kez elle tanımlar.
  SERVER_PUBLIC_IP: optional("SERVER_PUBLIC_IP"),

  // --- Webmail ---
  //
  // Webmail, aynı sunucudaki Dovecot ve Postfix'e LOOPBACK üzerinden bağlanır.
  // Dışarı açılmış bir port kullanılmaz: webmail'in IMAP trafiği panelin
  // içinden çıkmaz, dolayısıyla kendinden imzalı sertifika ve 143/STARTTLS
  // burada yeterlidir (bkz. lib/webmail-imap.ts).
  WEBMAIL_IMAP_HOST: optional("WEBMAIL_IMAP_HOST") ?? "127.0.0.1",
  WEBMAIL_IMAP_PORT: number("WEBMAIL_IMAP_PORT", 143),
  // Gönderim Postfix'in submission portundan, kimlik doğrulamalı gider.
  // 25 DEĞİL: 25 kimlik doğrulamasız ve sağlayıcı tarafından kapatılmış
  // durumda; submission zaten webmail kullanıcısının kendi hesabıyla
  // gönderdiğini garanti eder.
  WEBMAIL_SMTP_HOST: optional("WEBMAIL_SMTP_HOST") ?? "127.0.0.1",
  WEBMAIL_SMTP_PORT: number("WEBMAIL_SMTP_PORT", 587),
  // Webmail oturumunun ömrü. Panel oturumundan (7 gün) daha kısa: posta
  // kutusu parolası oturum boyunca sunucuda şifreli duruyor, pencereyi
  // gereksiz uzun tutmuyoruz.
  WEBMAIL_SESSION_HOURS: number("WEBMAIL_SESSION_HOURS", 12),

  // --- Yedekleme ---
  // Domain basina tutulacak surum sayisi. Rotasyon bunu asanlari siler AMA
  // son DOGRULANMIS yedegi asla silmez (bkz. backup-storage.ts rotateBackups).
  BACKUP_KEEP: number("BACKUP_KEEP", 7),
};
