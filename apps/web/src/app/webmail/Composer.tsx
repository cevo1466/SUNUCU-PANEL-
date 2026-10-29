"use client";

import { useEffect, useRef, useState } from "react";
import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListBulletIcon,
  PaperClipIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { webmailApi, WebmailApiError, fileToBase64, type OutgoingDraft } from "@/lib/webmail-api";

export interface ComposerSeed {
  to?: string;
  cc?: string;
  subject?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

interface PendingAttachment {
  file: File;
  /** Toplam boyut denetimi için; base64 gönderim anında üretilir. */
  size: number;
}

/** Sunucudaki sınırla aynı (routes/webmail.ts MAX_TOTAL_ATTACHMENT_BYTES). */
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Yeni mesaj / yanıt penceresi.
 *
 * ZENGİN METİN — `contentEditable` + `document.execCommand`. Bir editör
 * kütüphanesi eklemek bu iş için ağır olurdu: kalın, italik, liste ve bağlantı
 * dışında bir şey gerekmiyor ve mail HTML'i zaten basit olmalı (alıcı
 * istemcilerin çoğu karmaşık biçimlendirmeyi bozar). execCommand teknik olarak
 * "deprecated" ama tüm tarayıcılarda çalışıyor ve yerine geçen standart bir
 * API henüz yok — bilerek ve gerekçeyle kullanılıyor.
 *
 * DÜZ METİN KOPYASI HER ZAMAN GÖNDERİLİR: HTML okuyamayan istemciler ve
 * spam filtreleri için. Yalnızca HTML gönderen mail daha kolay spam'e düşer.
 */
export function Composer({
  seed,
  address,
  onClose,
  onSent,
}: {
  seed: ComposerSeed;
  address: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(seed.to ?? "");
  const [cc, setCc] = useState(seed.cc ?? "");
  const [showCc, setShowCc] = useState(Boolean(seed.cc));
  const [subject, setSubject] = useState(seed.subject ?? "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editorRef.current && seed.html) editorRef.current.innerHTML = seed.html;
    // Yanıtta imleç en üste: kullanıcı alıntının ÜSTÜNE yazar.
    editorRef.current?.focus();
  }, [seed.html]);

  const totalAttachmentBytes = attachments.reduce((sum, a) => sum + a.size, 0);

  function format(command: string) {
    editorRef.current?.focus();
    document.execCommand(command, false);
  }

  function insertLink() {
    const url = window.prompt("Bağlantı adresi (https://...)");
    if (!url) return;
    // javascript: gibi şemaları editöre hiç sokmuyoruz.
    if (!/^https?:\/\//i.test(url)) {
      setError("Bağlantı http:// veya https:// ile başlamalı.");
      return;
    }
    editorRef.current?.focus();
    document.execCommand("createLink", false, url);
  }

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const incoming = Array.from(list).map((file) => ({ file, size: file.size }));
    const next = [...attachments, ...incoming];
    const total = next.reduce((sum, a) => sum + a.size, 0);
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      setError(
        `Ekler toplamı ${formatBytes(total)} oldu; sınır ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}.`,
      );
      return;
    }
    setError(null);
    setAttachments(next);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function buildDraft(): Promise<OutgoingDraft> {
    const html = editorRef.current?.innerHTML ?? "";
    // Düz metin karşılığı: etiketleri sökerek. Mükemmel bir dönüşüm değil ama
    // HTML okuyamayan istemcinin eline boş bir mesaj geçmesinden iyidir.
    const text = (editorRef.current?.innerText ?? "").trim();
    const encoded = await Promise.all(
      attachments.map(async (a) => ({
        filename: a.file.name,
        contentType: a.file.type || "application/octet-stream",
        content: await fileToBase64(a.file),
      })),
    );
    return {
      to: to.trim(),
      cc: showCc && cc.trim() ? cc.trim() : undefined,
      subject: subject.trim(),
      html: html.trim() ? html : undefined,
      text: text || undefined,
      inReplyTo: seed.inReplyTo,
      references: seed.references,
      attachments: encoded.length ? encoded : undefined,
    };
  }

  async function send() {
    if (!to.trim()) {
      setError("Alıcı adresi gerekli.");
      return;
    }
    const bodyEmpty = !(editorRef.current?.innerText ?? "").trim();
    if (bodyEmpty && attachments.length === 0) {
      setError("Mesaj boş. Bir şeyler yazın veya dosya ekleyin.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await webmailApi.send(await buildDraft());
      // Kopya yazılamadıysa bunu SÖYLÜYORUZ. "Gönderildi" deyip kullanıcıyı
      // Gönderilenler'de boş bir klasörle karşılaştırmak güven kaybıdır.
      onSent();
      if (!result.savedToSent) {
        window.setTimeout(
          () => window.alert("Mesaj gönderildi, ancak Gönderilenler klasörüne kopyalanamadı."),
          0,
        );
      }
    } catch (err) {
      setError(err instanceof WebmailApiError ? err.message : "Mesaj gönderilemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    setBusy(true);
    setError(null);
    try {
      const result = await webmailApi.preview({
        subject: subject.trim(),
        html: editorRef.current?.innerHTML ?? "",
        text: editorRef.current?.innerText ?? "",
      });
      setPreviewHtml(result.html);
    } catch (err) {
      setError(err instanceof WebmailApiError ? err.message : "Önizleme açılamadı.");
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    setBusy(true);
    setError(null);
    try {
      const result = await webmailApi.saveDraft(await buildDraft());
      setNotice(result.saved ? "Taslak kaydedildi." : "Taslaklar klasörü bulunamadı.");
    } catch (err) {
      setError(err instanceof WebmailApiError ? err.message : "Taslak kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wm-composer" role="dialog" aria-label="Yeni mesaj">
      <header className="wm-composer-head">
        <h2>{seed.inReplyTo ? "Yanıtla" : "Yeni mesaj"}</h2>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Kapat" title="Kapat">
          <XMarkIcon aria-hidden="true" />
        </Button>
      </header>

      <div className="wm-composer-fields">
        <label className="wm-composer-row">
          <span>Kime</span>
          <input
            className="sp-input sp-mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="alici@alanadi.com"
            autoComplete="off"
          />
          {!showCc && (
            <button type="button" className="wm-linkish" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
        </label>

        {showCc && (
          <label className="wm-composer-row">
            <span>Cc</span>
            <input
              className="sp-input sp-mono"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="virgülle ayırın"
              autoComplete="off"
            />
          </label>
        )}

        <label className="wm-composer-row">
          <span>Konu</span>
          <input
            className="sp-input"
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setPreviewHtml(null); }}
            placeholder="Konu"
          />
        </label>
      </div>

      <div className="wm-composer-toolbar" role="toolbar" aria-label="Biçimlendirme">
        <button type="button" onClick={() => format("bold")} title="Kalın" aria-label="Kalın">
          <BoldIcon aria-hidden="true" />
        </button>
        <button type="button" onClick={() => format("italic")} title="İtalik" aria-label="İtalik">
          <ItalicIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => format("insertUnorderedList")}
          title="Madde listesi"
          aria-label="Madde listesi"
        >
          <ListBulletIcon aria-hidden="true" />
        </button>
        <button type="button" onClick={insertLink} title="Bağlantı ekle" aria-label="Bağlantı ekle">
          <LinkIcon aria-hidden="true" />
        </button>
        <span className="wm-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Dosya ekle"
          aria-label="Dosya ekle"
        >
          <PaperClipIcon aria-hidden="true" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div
        ref={editorRef}
        className="wm-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Mesaj metni"
        onInput={() => setPreviewHtml(null)}
      />

      {address.toLowerCase().endsWith("@mervenuruluc.com.tr") && (
        <p className="wm-composer-notice">Mor M kurumsal tasarımı gönderimde otomatik uygulanır. Mesaj metninizi buraya yazın.</p>
      )}

      {previewHtml && (
        <div className="wm-brand-preview">
          <div className="wm-brand-preview-head">
            <strong>Alıcı görünümü</strong>
            <button type="button" onClick={() => setPreviewHtml(null)}>Önizlemeyi kapat</button>
          </div>
          <iframe title="Gönderilecek e-postanın önizlemesi" sandbox="" srcDoc={previewHtml} />
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="wm-attach-list">
          {attachments.map((a, index) => (
            <li key={`${a.file.name}-${index}`}>
              <PaperClipIcon aria-hidden="true" />
              <span className="wm-attach-name">{a.file.name}</span>
              <span className="wm-attach-size sp-mono">{formatBytes(a.size)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(index)}
                aria-label={`${a.file.name} ekini kaldır`}
                title="Kaldır"
              >
                <XMarkIcon aria-hidden="true" />
              </button>
            </li>
          ))}
          <li className="wm-attach-total sp-mono">
            toplam {formatBytes(totalAttachmentBytes)} / {formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}
          </li>
        </ul>
      )}

      {error && (
        <p className="wm-composer-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="wm-composer-notice">{notice}</p>}

      <footer className="wm-composer-foot">
        <Button variant="secondary" onClick={preview} disabled={busy}>
          Önizle
        </Button>
        <Button variant="primary" onClick={send} loading={busy}>
          Gönder
        </Button>
        <Button variant="secondary" onClick={saveDraft} disabled={busy}>
          Taslağa kaydet
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
      </footer>
    </div>
  );
}
