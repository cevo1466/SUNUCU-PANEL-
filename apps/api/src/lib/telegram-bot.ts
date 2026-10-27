import { env } from "../env.js";
import { buildStatusReport } from "./alerts.js";
import {
  clip,
  escapeHtml,
  getTelegramUpdates,
  isTelegramConfigured,
  sendTelegramMessage,
} from "./telegram.js";

/**
 * Telegram komut botu — long-poll.
 *
 * Webhook DEGIL long-poll kullaniliyor: webhook, Telegram'in ulasabildigi
 * sabit ve gecerli sertifikali bir HTTPS adresi ister; panel su an duz HTTP
 * uzerinden sunuluyor. Long-poll disaridan erisim gerektirmez.
 */

/** Bot kapaliyken birikmis komutlara yanit verilmez; bu yastan eskiler atilir. */
const MAX_COMMAND_AGE_SEC = 180;
/** Ag hatasindan sonra beklenen sure — sikisik bir hata dongusune girmemek icin. */
const ERROR_BACKOFF_MS = 5_000;
/** Iki tur arasindaki asgari bekleme; Telegram ani donse bile CPU yakmayalim. */
const MIN_LOOP_DELAY_MS = 500;

const HELP = [
  "🤖 <b>Studio Panel bot</b>",
  "",
  "/durum — CPU, bellek, disk ve uptime özeti",
  "/yardim — bu mesaj",
].join("\n");

let running = false;
let offset = 0;
let controller: AbortController | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "/durum@Kaynak_Takip_Bot" -> "/durum". Telegram gruplarda komuta bot
 * kullanici adini ekler; ham metinle karsilastirma bu yuzden bosa duserdi.
 */
function normalizeCommand(text: string): string {
  const first = text.trim().split(/\s+/)[0] ?? "";
  return first.split("@")[0].toLowerCase();
}

async function handleCommand(command: string, chatId: string): Promise<void> {
  switch (command) {
    case "/durum":
    case "/status":
    case "/kaynak":
      try {
        await sendTelegramMessage(await buildStatusReport(), chatId);
      } catch (err) {
        // Rapor uretilemediyse SESSIZ KALINMAZ: kullanici komutu yazdi,
        // yanit beklemekte. Neyin bozuldugunu soylemek "bot olmus" sanmaktan
        // iyidir.
        // Hata metni disaridan gelebilir: kacislanir ve kirpilir, ham
        // haliyle HTML'e gomulmez.
        await sendTelegramMessage(
          `⚠️ Durum raporu alınamadı: ${escapeHtml(clip((err as Error).message))}`,
          chatId,
        ).catch(() => undefined);
      }
      return;
    case "/start":
    case "/yardim":
    case "/help":
      await sendTelegramMessage(HELP, chatId).catch(() => undefined);
      return;
    default:
      // Bilinmeyen komut: sessiz kalmak yerine ne yapabildigini soyler.
      if (command.startsWith("/")) {
        await sendTelegramMessage(HELP, chatId).catch(() => undefined);
      }
  }
}

async function pollOnce(signal: AbortSignal): Promise<void> {
  const updates = await getTelegramUpdates(offset, 25, signal);
  const nowSec = Math.floor(Date.now() / 1000);

  for (const update of updates) {
    // Offset HER ZAMAN ilerletilir — islenmeyen bir guncelleme de
    // "goruldu" sayilir. Aksi halde islenmeyen tek bir mesaj sonsuza kadar
    // her turda yeniden teslim edilir ve bot ilerlemez.
    offset = update.update_id + 1;

    const text = update.message?.text?.trim();
    const chatId = update.message?.chat.id;
    // Sadece yapilandirilmis chat'ten gelen komutlara yanit verilir —
    // bot baska biri tarafindan bulunup rastgele tetiklenmesin.
    if (!text || String(chatId) !== env.TELEGRAM_CHAT_ID) continue;

    // Bayat komutlari atla. Telegram teslim edilmemis guncellemeleri 24 saat
    // saklar; API yeniden baslatildiginda offset 0'dan basladigi icin bir
    // gunluk birikmis "/durum" pesi sira yanitlanip spam olusturuyordu.
    const sentAt = update.message?.date;
    if (typeof sentAt === "number" && nowSec - sentAt > MAX_COMMAND_AGE_SEC) continue;

    // Yanit HER ZAMAN yapilandirilmis chat'e gider. Yukaridaki esitlik
    // kontrolu bunu zaten garantiliyor; yine de gelen veriyi degil
    // yapilandirmayi kaynak almak, ileride kontrol gevsetilirse botun
    // yabanci bir chat'e yazmasini yapisal olarak engeller.
    await handleCommand(normalizeCommand(text), env.TELEGRAM_CHAT_ID);
  }
}

async function loop(): Promise<void> {
  while (running) {
    const signal = controller?.signal;
    try {
      await pollOnce(signal ?? new AbortController().signal);
      await sleep(MIN_LOOP_DELAY_MS);
    } catch (err) {
      if (!running) return;
      // 409 Conflict = ayni token ile baska bir surec de getUpdates cagiriyor.
      // Servis yeniden baslatilirken eski surec birkac saniye daha yasayabilir;
      // beklemek bunu kendiliginden cozer.
      const message = (err as Error).message ?? "";
      const isConflict = message.includes("409");
      // Ag hatasinda sessizce bir sonraki turda tekrar dener — long-poll
      // dongusu hicbir zaman kendi kendine olmemeli.
      await sleep(isConflict ? ERROR_BACKOFF_MS * 2 : ERROR_BACKOFF_MS);
    }
  }
}

/**
 * Kullanıcı Telegram'dan /durum yazınca anlık kaynak+uptime raporu döner —
 * "telefonda tek tıkla kaynak kontrolü" isteği bu.
 */
export function startTelegramBot(): void {
  if (running) return;
  if (!isTelegramConfigured()) return;
  running = true;
  controller = new AbortController();
  void loop();
}

export function stopTelegramBot(): void {
  running = false;
  // Askidaki long-poll'u hemen keser: aksi halde surec kapanirken 25 saniye
  // daha bekliyordu.
  controller?.abort();
  controller = null;
}
