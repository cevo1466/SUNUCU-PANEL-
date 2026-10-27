import type { Metadata } from "next";
import { headers } from "next/headers";
import { ToastProvider } from "@/components/ui/Toast";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

/*
  YAZI TİPİ — bilinçli olarak indirilmiyor.

  Aile adları Plesk Obsidian'ın kendi token'larından birebir alındı
  (`--pul-font-family-body` ve `--pul-font-family-code`). Plesk de bu
  yazıları kendi barındırmıyor, yalnızca aileyi bildiriyor.

  `next/font/google` kullanılmıyor: her `next build`, fonts.googleapis.com'a
  istek atıyor ve bu konteynerde o istek dakikalarca "Retrying n/3" ile
  dönüyordu — derleme dış bir servise bağımlı hale geliyor, panel o sürede
  kapalı kalıyordu. Yığın, sistemde bulunması çok muhtemel yedeklerle
  bittiği için görünüm her makinede öngörülebilir.

  Aile tanımları globals.css'teki @theme bloğunda.
*/

export const metadata: Metadata = {
  title: process.env.PANEL_DISPLAY_NAME ?? "Studio Panel",
  description: "Web hosting kontrol paneli",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // middleware.ts CSP'sinin script-src'sindeki nonce'un AYNISI — eslesmezse
  // tarayici bu betigi SESSIZCE bloklar ve tema hep acikta kalir (FOUC).
  // /adminer ve webmail.* icin middleware CSP eklemedigi icin orada bu
  // baslik yok; `null` durumunda script nonce'suz basar (o yollarda CSP
  // zaten yok, tarayici engellemez).
  const nonce = (await headers()).get("x-nonce");
  return (
    /*
      suppressHydrationWarning: aşağıdaki betik `data-theme`'i sunucu HTML'ine
      göre DEĞİŞTİRİR (sunucu kullanıcının tercihini bilemez). Uyarı yalnızca
      bu elemanın kendi öznitelikleri için susturulur, ağacın geri kalanı
      normal şekilde denetlenir.
    */
    <html lang="tr" suppressHydrationWarning>
      <head>
        {/* İlk boyamadan önce temayı yerine koyar; gerekçe: lib/theme.ts */}
        <script nonce={nonce ?? undefined} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
