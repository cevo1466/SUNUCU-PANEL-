import { env } from "../env.js";

const DIVIDER = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬";

/**
 * Mesajlar `parse_mode: "HTML"` ile gonderiliyor; karta konan degerler bu
 * yuzden HTML olarak yorumlanir. Degerlerin bir kismi DIS KAYNAKLIDIR —
 * HetrixTools monitor adi/hedefi, dosya sistemi yolu, hata metinleri.
 * Icinde `<` gecen tek bir monitor adi Telegram'in ayristiricisini bozar,
 * API 400 doner ve uyari HIC GITMEZ; yani kritik bir alarm sessizce kaybolur.
 * Kacislama bunu engeller ve isaretleme enjeksiyonunu kapatir.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cok uzun hata metinleri karti sismesin (Telegram siniri 4096 karakter). */
export function clip(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function formatTimestamp(): string {
  return new Date().toLocaleString("tr-TR", { timeZone: "UTC" }) + " UTC";
}

export type AlertTone = "critical" | "ok" | "down" | "still-down" | "up" | "status";

const TONE_META: Record<AlertTone, { emoji: string; label: string }> = {
  critical: { emoji: "🔴", label: "KAYNAK UYARISI" },
  ok: { emoji: "🟢", label: "NORMALE DÖNDÜ" },
  down: { emoji: "🔴", label: "CRITICAL: SUNUCU ERİŞİLEMEZ" },
  // Down surerken periyodik ozet — yeni bir alarm DEGIL, bu yuzden kirmizi
  // degil turuncu ve "CRITICAL" degil "hala down" tonu.
  "still-down": { emoji: "🟠", label: "HÂLÂ DOWN (ÖZET)" },
  up: { emoji: "🟢", label: "RESOLVED: SİSTEM TEKRAR YAYINDA" },
  // Kullanıcının /durum komutuyla elle istediği anlık kaynak raporu —
  // bir alarm değil, o yüzden ayrı (nötr) etiket.
  status: { emoji: "📊", label: "ANLIK DURUM" },
};

/**
 * Panelin bütün Telegram bildirimleri için TEK ortak kart şablonu — hepsi
 * aynı görsel formatta gitsin diye alerts.ts bunun dışında elle metin
 * kurmaz. `fields` sırayla "🔹 Etiket: <b>değer</b>" satırları olur.
 */
export function formatAlertCard(
  tone: AlertTone,
  title: string,
  fields: Array<[label: string, value: string]>,
): string {
  const meta = TONE_META[tone];
  const lines = [
    `${meta.emoji} <b>${meta.label}</b> · ${escapeHtml(title)}`,
    DIVIDER,
    ...fields.map(([label, value]) => `🔹 ${escapeHtml(label)}: <b>${escapeHtml(value)}</b>`),
    DIVIDER,
    `🖥 Studio Panel · 🕒 ${formatTimestamp()}`,
  ];
  return lines.join("\n");
}

export function isTelegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/**
 * Telegram Bot API'sine tek bir mesaj gönderir. Token/chat id tanımlı
 * değilse sessizce hiçbir şey yapmaz — alerts.ts bu yüzden "yapılandırılmadı"
 * durumunu ayrıca loglamaz, tek doğruluk kaynağı burasıdır.
 */
export async function sendTelegramMessage(text: string, chatId?: string): Promise<void> {
  if (!isTelegramConfigured()) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId ?? env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
    // Node'un fetch'inde VARSAYILAN ZAMAN ASIMI YOKTUR. Aglar takildiginda
    // bu cagri sonsuza kadar asili kalir; uyari gonderen kod yolu da onunla
    // birlikte donar (alarm izleyicisi tick'i bir daha donmezdi).
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    /** Unix saniye. Bayat (bot kapaliyken birikmis) komutlari elemek icin. */
    date?: number;
    chat: { id: number };
  };
}

/**
 * Long-polling ile bekleyen mesajları çeker (webhook yok — bu ortamda dışa
 * açık/TLS'li sabit bir URL yok, long-poll bunu gerektirmez). `timeoutSec`
 * kadar Telegram tarafında bekletilir, yeni mesaj gelince hemen döner.
 */
export async function getTelegramUpdates(
  offset: number,
  timeoutSec = 25,
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  if (!isTelegramConfigured()) return [];
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=${timeoutSec}`;

  // Long-poll sunucu tarafinda timeoutSec bekler; istemci tarafinda buna 10
  // saniye pay birakilir. Zaman asimi OLMADAN: TCP baglantisi sessizce
  // olduginde fetch asla donmez ve bot bir daha HICBIR komuta yanit vermez —
  // "bot calisiyor gorunuyor ama cevap vermiyor" tam olarak buydu.
  const timeoutSignal = AbortSignal.timeout((timeoutSec + 10) * 1000);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(url, { signal: combined });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram getUpdates ${res.status}: ${body}`);
  }
  const body = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
  return body.ok ? body.result : [];
}
