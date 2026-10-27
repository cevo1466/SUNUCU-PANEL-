"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/button";

/**
 * Mesaj gövdesini gösterir.
 *
 * GÜVENLİK — İKİ KATMAN, ÇÜNKÜ BİR KATMAN YETMEZ:
 *
 * 1. Sunucu tarafı temizlik (apps/api lib/webmail-mail.ts `sanitizeHtml`):
 *    script/iframe/object düğümleri, `on*` öznitelikleri ve javascript: URL'leri
 *    söker.
 * 2. Burada: gövde `sandbox` iframe içinde, `allow-same-origin` OLMADAN
 *    gösterilir. Bu, HTML'in panelin origin'ine erişimini tamamen keser —
 *    birinci katmandan bir şey kaçsa bile çerezlere, localStorage'a veya DOM'a
 *    ulaşamaz.
 *
 * Tek katmana (regex temizliğine) güvenmek yanlış olurdu: mail gövdesi
 * tamamen güvenilmez girdidir ve saldırgan yalnızca mail göndererek deneme
 * yapabilir. `srcdoc` + kısıtlı sandbox, kaçışın bedelini sıfıra indirir.
 *
 * UZAK GÖRSELLER: sunucu `src`'leri `data-blocked-src`'ye çevirdi. Kullanıcı
 * açıkça isterse geri yazılır. Varsayılan engel, izleme piksellerinin mail
 * açılır açılmaz gönderene "okundu" sinyali göndermesini durdurur.
 */
export function MessageBody({ html, text }: { html: string | null; text: string | null }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [showRemote, setShowRemote] = useState(false);
  const [height, setHeight] = useState(240);

  const hasBlockedImages = useMemo(
    () => Boolean(html && html.includes("data-blocked-src")),
    [html],
  );

  const srcDoc = useMemo(() => {
    if (!html) return null;
    const body = showRemote ? html.replace(/data-blocked-src=/g, "src=") : html;
    // Gövdenin kendi stili panelin temasını bilmiyor; okunur bir taban veriyoruz.
    // Renkler iframe içinde sabit: mail HTML'i genelde açık zemin varsayar ve
    // koyu tema token'larını oraya taşımak çoğu maili okunmaz hale getirirdi.
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#ffffff;color:#202020;}
  body{font:14px/1.6 "Open Sans","Segoe UI",Helvetica,Arial,sans-serif;padding:14px;word-break:break-word;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  a{color:#16759a;}
  pre{white-space:pre-wrap;word-break:break-word;}
</style></head><body>${body}</body></html>`;
  }, [html, showRemote]);

  // İçerik yüksekliğine uyum. Sabit yükseklik uzun maillerde iç içe kaydırma
  // çubuğu demekti; kullanıcı sayfayı kaydırırken mail gövdesi yerinde kalıyordu.
  useEffect(() => {
    if (!srcDoc) return;
    const frame = frameRef.current;
    if (!frame) return;
    function measure() {
      try {
        const doc = frame!.contentDocument;
        if (!doc) return;
        const next = Math.min(Math.max(doc.body.scrollHeight + 24, 160), 20000);
        setHeight(next);
      } catch {
        /* sandbox erişimi engelledi: varsayılan yükseklikte kal */
      }
    }
    frame.addEventListener("load", measure);
    const timer = setInterval(measure, 500);
    // Görseller geç yüklenip yüksekliği değiştirebiliyor; birkaç saniye izleyip
    // bırakıyoruz (sürekli ölçüm gereksiz CPU).
    const stop = setTimeout(() => clearInterval(timer), 5000);
    return () => {
      frame.removeEventListener("load", measure);
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [srcDoc]);

  if (srcDoc) {
    return (
      <div className="wm-body">
        {hasBlockedImages && !showRemote && (
          <div className="wm-remote-notice">
            <PhotoIcon aria-hidden="true" />
            <span>Uzak görseller engellendi. Görseller gönderene okunduğunu bildirebilir.</span>
            <Button size="sm" variant="secondary" onClick={() => setShowRemote(true)}>
              Görselleri göster
            </Button>
          </div>
        )}
        <iframe
          ref={frameRef}
          className="wm-body-frame"
          style={{ height }}
          // allow-same-origin YOK: iframe kendi origin'inde izole kalır.
          // allow-popups, <base target="_blank"> ile bağlantıların açılması için.
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          title="Mesaj içeriği"
        />
      </div>
    );
  }

  return (
    <div className="wm-body">
      <pre className="wm-body-text">{text || "(bu mesajın içeriği boş)"}</pre>
    </div>
  );
}
