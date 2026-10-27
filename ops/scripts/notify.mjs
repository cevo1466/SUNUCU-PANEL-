#!/usr/bin/env node
/**
 * ops/scripts/notify.mjs "<baslik>" "<mesaj>" [ton]
 *
 * Kabuk script'lerinin panelin Telegram bildirimini kullanmasi icin.
 * ton: critical | ok | down | status  (varsayilan: critical)
 *
 * NEDEN VAR (gercek kusur, 2026-09-01): `ssl-renew.sh` 3 ardisik hatada
 * /var/log/studio-panel-ssl-alerts.log dosyasina bir satir yaziyordu ve
 * O DOSYAYI KIMSE OKUMUYORDU. Yani sertifika yenilemesi ust uste basarisiz
 * olsa bile kimsenin haberi olmayacakti; ariza ancak site HTTPS vermeyi
 * birakinca fark edilecekti. Panelde zaten calisan bir Telegram yolu var
 * (apps/api/src/lib/telegram.ts); alarm oraya baglaniyor.
 *
 * Telegram yapilandirilmamissa SESSIZCE cikar (0) — panelin kendi davranisiyla
 * ayni: bildirim yoksa is basarisiz sayilmaz.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const raw = readFileSync(path.join(projectRoot, ".env.loopkit"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* dosya yok */
  }
  return undefined;
}

const TONE_ICON = { critical: "🔴", ok: "🟢", down: "🔴", status: "ℹ️" };

const [title, body, tone = "critical"] = process.argv.slice(2);
if (!title) {
  console.error('Kullanim: notify.mjs "<baslik>" "<mesaj>" [ton]');
  process.exit(2);
}

const token = envValue("TELEGRAM_BOT_TOKEN");
const chatId = envValue("TELEGRAM_CHAT_ID");
if (!token || !chatId) {
  // Sessiz no-op: apps/api/src/lib/telegram.ts ile ayni sozlesme.
  process.exit(0);
}

// Telegram HTML ayristiricisi < > & karakterlerinde bozulur; kacislanmazsa
// mesaj sessizce DUSER (panelde daha once tam olarak bu yasandi).
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const icon = TONE_ICON[tone] ?? TONE_ICON.critical;
const text = `${icon} <b>${esc(title)}</b>\n\n${esc(body ?? "")}`;

try {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error(`notify: Telegram ${res.status}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`notify: ${err.message}`);
  process.exitCode = 1;
}
