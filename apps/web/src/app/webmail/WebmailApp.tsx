"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ArrowRightStartOnRectangleIcon,
  ArchiveBoxIcon,
  DocumentIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  ExclamationTriangleIcon,
  InboxIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  PencilSquareIcon,
  StarIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { StarIcon as StarSolid } from "@heroicons/react/24/solid";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import {
  webmailApi,
  WebmailApiError,
  type Mailbox,
  type MessageDetail,
  type MessageSummary,
  type Quota,
} from "@/lib/webmail-api";
import { MessageBody } from "./MessageBody";
import { Composer, type ComposerSeed } from "./Composer";

const FOLDER_ICONS: Record<string, typeof InboxIcon> = {
  inbox: InboxIcon,
  sent: PaperAirplaneIcon,
  drafts: DocumentIcon,
  trash: TrashIcon,
  junk: ExclamationTriangleIcon,
};

/**
 * Tarihi listede kısa gösterir: bugünse saat, bu yılsa gün/ay, yoksa yıl.
 *
 * Tam tarih listede yer israfı ve tarama hızını düşürüyor; kullanıcı listede
 * "ne zaman"ı kabaca, açtığı mesajda tam olarak görmek istiyor.
 */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) return d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
  return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fullDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

function displayName(person: { name: string; address: string } | null): string {
  if (!person) return "(gönderen yok)";
  return person.name || person.address;
}

/** Yanıt gövdesi: alıntıyı görsel olarak ayırır, imleç üstte kalır. */
function quoteFor(message: MessageDetail): string {
  const who = displayName(message.from);
  const when = fullDate(message.date);
  const inner = message.html ?? `<pre>${(message.text ?? "").replace(/[<>&]/g, "")}</pre>`;
  return `<p><br></p><p>—</p><p>${when} tarihinde ${who} yazdı:</p><blockquote style="margin:0 0 0 12px;padding-left:12px;border-left:2px solid #ccc;">${inner}</blockquote>`;
}

export function WebmailApp({ address, onSignedOut }: { address: string; onSignedOut: () => void }) {
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [current, setCurrent] = useState("INBOX");
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selectedUids, setSelectedUids] = useState<number[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<MessageDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [composer, setComposer] = useState<ComposerSeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Dar ekranda hangi bölme görünüyor. */
  const [mobilePane, setMobilePane] = useState<"list" | "message">("list");

  const loadMailboxes = useCallback(async () => {
    try {
      const data = await webmailApi.mailboxes();
      setMailboxes(data.mailboxes);
      setQuota(data.quota);
    } catch (err) {
      if (err instanceof WebmailApiError && err.status === 401) return onSignedOut();
      setError(err instanceof WebmailApiError ? err.message : "Klasörler okunamadı.");
    }
  }, [onSignedOut]);

  const loadMessages = useCallback(
    async (mailbox: string, term: string, pageOffset = 0) => {
      setLoadingList(true);
      setError(null);
      try {
        const data = await webmailApi.messages(mailbox, { search: term || undefined, offset: pageOffset });
        setMessages(data.messages);
        setTotal(data.total);
        setSelectedUids((previous) => previous.filter((uid) => data.messages.some((message) => message.uid === uid)));
      } catch (err) {
        if (err instanceof WebmailApiError && err.status === 401) return onSignedOut();
        setMessages([]);
        setError(err instanceof WebmailApiError ? err.message : "Mesajlar okunamadı.");
      } finally {
        setLoadingList(false);
      }
    },
    [onSignedOut],
  );

  useEffect(() => {
    void loadMailboxes();
  }, [loadMailboxes]);

  useEffect(() => {
    void loadMessages(current, activeSearch, offset);
    setSelected(null);
    setSelectedUids([]);
  }, [current, activeSearch, offset, loadMessages]);

  async function openMessage(summary: MessageSummary) {
    setLoadingMessage(true);
    setMobilePane("message");
    try {
      const detail = await webmailApi.message(current, summary.uid);
      setSelected(detail);
      // Okundu bilgisi listede de anında yansısın; sunucu zaten işaretledi.
      setMessages((prev) =>
        prev ? prev.map((m) => (m.uid === summary.uid ? { ...m, seen: true } : m)) : prev,
      );
      void loadMailboxes();
    } catch (err) {
      if (err instanceof WebmailApiError && err.status === 401) return onSignedOut();
      setError(err instanceof WebmailApiError ? err.message : "Mesaj açılamadı.");
    } finally {
      setLoadingMessage(false);
    }
  }

  async function toggleFlag(message: MessageSummary) {
    const next = !message.flagged;
    setMessages((prev) =>
      prev ? prev.map((m) => (m.uid === message.uid ? { ...m, flagged: next } : m)) : prev,
    );
    try {
      await webmailApi.flag(current, [message.uid], "flagged", next);
    } catch {
      // İyimser güncelleme geri alınır — kullanıcıya yalan bir durum bırakmayız.
      setMessages((prev) =>
        prev ? prev.map((m) => (m.uid === message.uid ? { ...m, flagged: !next } : m)) : prev,
      );
    }
  }

  const trashSelected = mailboxes?.find((box) => box.path === current)?.role === "trash";
  const permanentDeletion = !mailboxes || trashSelected || !mailboxes.some((box) => box.role === "trash");
  const visibleUids = messages?.map((m) => m.uid) ?? [];
  const allVisibleSelected = visibleUids.length > 0 && visibleUids.every((uid) => selectedUids.includes(uid));

  function toggleSelection(uid: number) {
    setSelectedUids((prev) => prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]);
  }

  async function removeMessages(uids: number[]) {
    if (!uids.length || deleting) return;
    if (permanentDeletion && !window.confirm(`${uids.length} mesaj kalıcı olarak silinecek. Devam etmek istiyor musunuz?`)) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await webmailApi.remove(current, uids);
      const removed = new Set(uids);
      setMessages((prev) => (prev ? prev.filter((m) => !removed.has(m.uid)) : prev));
      setSelectedUids([]);
      setTotal((prev) => Math.max(0, prev - uids.length));
      if (selected && removed.has(selected.uid)) {
        setSelected(null);
        setMobilePane("list");
      }
      void loadMailboxes();
      setNotice(`${uids.length} mesaj ${result.permanent ? "kalıcı olarak silindi" : "Çöp kutusuna taşındı"}.`);
      const nextOffset = Math.max(0, offset - (visibleUids.length === uids.length && offset > 0 ? 50 : 0));
      if (nextOffset !== offset) setOffset(nextOffset);
      else void loadMessages(current, activeSearch, nextOffset);
    } catch (err) {
      setError(err instanceof WebmailApiError ? err.message : "Mesaj silinemedi.");
    } finally {
      setDeleting(false);
    }
  }

  async function markUnread(uid: number) {
    try {
      await webmailApi.flag(current, [uid], "seen", false);
      setMessages((prev) =>
        prev ? prev.map((m) => (m.uid === uid ? { ...m, seen: false } : m)) : prev,
      );
      setSelected(null);
      setMobilePane("list");
      void loadMailboxes();
    } catch {
      setError("Okunmadı olarak işaretlenemedi.");
    }
  }

  function reply(message: MessageDetail, all: boolean) {
    const to = message.from?.address ?? "";
    const cc = all
      ? [...message.to, ...message.cc]
          .map((a) => a.address)
          .filter((a) => a && a !== address && a !== to)
          .join(", ")
      : "";
    setComposer({
      to,
      cc: cc || undefined,
      subject: message.subject.toLowerCase().startsWith("re:")
        ? message.subject
        : `Re: ${message.subject}`,
      html: quoteFor(message),
      inReplyTo: message.messageId ?? undefined,
      references: [...(message.references ?? []), message.messageId ?? ""].filter(Boolean),
    });
  }

  function forward(message: MessageDetail) {
    setComposer({
      to: "",
      subject: message.subject.toLowerCase().startsWith("fwd:")
        ? message.subject
        : `Fwd: ${message.subject}`,
      html: quoteFor(message),
    });
  }

  async function signOut() {
    try {
      await webmailApi.logout();
    } finally {
      onSignedOut();
    }
  }

  const quotaPercent = useMemo(() => {
    if (!quota?.limitBytes || quota.usedBytes === null) return null;
    return Math.min(100, (quota.usedBytes / quota.limitBytes) * 100);
  }, [quota]);

  const quotaState = quotaPercent === null ? "ok" : quotaPercent >= 90 ? "err" : quotaPercent >= 75 ? "warn" : "ok";

  return (
    <div className="wm-shell" data-pane={mobilePane}>
      {/* --- Sol: klasörler + kota --- */}
      <aside className="wm-side">
        <div className="wm-side-brand">
          <EnvelopeIcon aria-hidden="true" />
          <span>Webmail</span>
        </div>

        <Button variant="primary" block onClick={() => setComposer({ to: "", subject: "" })}>
          <PencilSquareIcon aria-hidden="true" />
          Yeni mesaj
        </Button>

        <nav className="wm-folders" aria-label="Klasörler">
          {mailboxes === null ? (
            <p className="wm-side-loading">Klasörler yükleniyor…</p>
          ) : (
            mailboxes.map((box) => {
              const Icon = (box.role && FOLDER_ICONS[box.role]) || ArchiveBoxIcon;
              return (
                <button
                  key={box.path}
                  className="wm-folder"
                  data-active={box.path === current}
                  onClick={() => {
                    setCurrent(box.path);
                    setSearch("");
                    setActiveSearch("");
                    setOffset(0);
                    setMobilePane("list");
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span className="wm-folder-label">{box.label}</span>
                  {box.unseen > 0 && <span className="wm-folder-count">{box.unseen}</span>}
                </button>
              );
            })
          )}
        </nav>

        {/*
          KOTA — bu webmail'i genel bir mail istemcisinden ayıran şey.
          Barındırma hesabında posta kutusu sınırlı ve kullanıcı sınıra
          dayandığında mail ALAMAZ hale gelir; bunu ayarlar içinde saklamak
          yerine her zaman görünür tutuyoruz. Ölçülemediğinde sayı uydurmuyoruz.
        */}
        <div className="wm-quota" data-state={quotaState}>
          <div className="wm-quota-head">
            <span>Posta kutusu</span>
            <span className="sp-mono">
              {quota && quota.usedBytes !== null && quota.limitBytes
                ? `${formatBytes(quota.usedBytes)} / ${formatBytes(quota.limitBytes)}`
                : "ölçülemedi"}
            </span>
          </div>
          <div
            className="wm-quota-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={quotaPercent ?? 0}
            aria-label="Posta kutusu doluluk oranı"
          >
            <div className="wm-quota-fill" style={{ width: `${quotaPercent ?? 0}%` }} />
          </div>
          {quotaState === "err" && (
            <p className="wm-quota-warn">Kutu neredeyse dolu. Yer açmazsanız yeni mail alamazsınız.</p>
          )}
        </div>

        <div className="wm-side-foot">
          <span className="wm-account sp-mono" title={address}>
            {address}
          </span>
          <ThemeToggle />
          <Button size="icon" variant="ghost" onClick={signOut} aria-label="Çıkış yap" title="Çıkış yap">
            <ArrowRightStartOnRectangleIcon aria-hidden="true" />
          </Button>
        </div>
      </aside>

      {/* --- Orta: mesaj listesi --- */}
      <section className="wm-list-pane" aria-label="Mesaj listesi">
        <header className="wm-list-head">
          <form
            className="wm-search"
            onSubmit={(e) => {
              e.preventDefault();
              setOffset(0);
              setActiveSearch(search.trim());
            }}
          >
            <MagnifyingGlassIcon aria-hidden="true" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Bu klasörde ara"
              aria-label="Mesajlarda ara"
            />
            {activeSearch && (
              <button
                type="button"
                className="wm-linkish"
                onClick={() => {
                  setSearch("");
                  setActiveSearch("");
                  setOffset(0);
                }}
              >
                Temizle
              </button>
            )}
          </form>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => void loadMessages(current, activeSearch, offset)}
            aria-label="Yenile"
            title="Yenile"
          >
            <ArrowPathIcon aria-hidden="true" />
          </Button>
        </header>

        {error && (
          <p className="wm-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="wm-notice" role="status">{notice}</p>}

        {messages && messages.length > 0 && (
          <div className="wm-bulkbar">
            <label className="wm-select-all">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(e) => setSelectedUids(e.target.checked ? visibleUids : [])}
                aria-label="Bu sayfadaki mesajların tümünü seç"
              />
              Bu sayfadakileri seç
            </label>
            {selectedUids.length > 0 && (
              <Button size="sm" variant="danger" disabled={deleting} onClick={() => void removeMessages(selectedUids)}>
                <TrashIcon aria-hidden="true" />
                {deleting ? "Siliniyor…" : `${selectedUids.length} mesajı sil`}
              </Button>
            )}
          </div>
        )}

        <div className="wm-list">
          {loadingList ? (
            <p className="wm-list-empty">Mesajlar yükleniyor…</p>
          ) : !messages || messages.length === 0 ? (
            <div className="wm-list-empty">
              <EnvelopeOpenIcon aria-hidden="true" />
              <p>{activeSearch ? `“${activeSearch}” için sonuç yok.` : "Bu klasör boş."}</p>
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <article
                  key={m.uid}
                  className="wm-row"
                  data-unread={!m.seen}
                  data-selected={selected?.uid === m.uid}
                >
                  <input
                    className="wm-row-check"
                    type="checkbox"
                    checked={selectedUids.includes(m.uid)}
                    onChange={() => toggleSelection(m.uid)}
                    aria-label={`${m.subject} mesajını seç`}
                  />
                  <button
                    className="wm-row-star"
                    onClick={() => void toggleFlag(m)}
                    aria-label={m.flagged ? "Yıldızı kaldır" : "Yıldızla"}
                    title={m.flagged ? "Yıldızı kaldır" : "Yıldızla"}
                  >
                    {m.flagged ? <StarSolid aria-hidden="true" /> : <StarIcon aria-hidden="true" />}
                  </button>
                  <button className="wm-row-main" onClick={() => void openMessage(m)}>
                    <span className="wm-row-from">
                      {displayName(current.toLowerCase().includes("sent") ? m.to[0] ?? null : m.from)}
                    </span>
                    <span className="wm-row-subject">{m.subject}</span>
                    <span className="wm-row-meta">
                      {m.hasAttachments && <PaperClipIcon aria-hidden="true" />}
                      <span className="wm-row-date sp-mono">{shortDate(m.date)}</span>
                    </span>
                  </button>
                </article>
              ))}
              <div className="wm-list-total">
                {activeSearch
                  ? `${offset + 1}–${offset + messages.length} / ${total} arama sonucu`
                  : `${offset + 1}–${offset + messages.length} / ${total} mesaj`}
                <div className="wm-page-actions">
                  <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Önceki</Button>
                  <Button size="sm" variant="ghost" disabled={offset + messages.length >= total} onClick={() => setOffset(offset + 50)}>Sonraki</Button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* --- Sağ: okuma bölmesi --- */}
      <section className="wm-read-pane" aria-label="Mesaj">
        {loadingMessage ? (
          <p className="wm-list-empty">Mesaj açılıyor…</p>
        ) : !selected ? (
          <div className="wm-list-empty wm-read-empty">
            <EnvelopeIcon aria-hidden="true" />
            <p>Okumak için soldan bir mesaj seçin.</p>
          </div>
        ) : (
          <article className="wm-message">
            <header className="wm-message-head">
              <button
                className="wm-back"
                onClick={() => setMobilePane("list")}
                aria-label="Listeye dön"
              >
                <ArrowLeftIcon aria-hidden="true" />
              </button>
              <h1 className="wm-message-subject">{selected.subject}</h1>
              <div className="wm-message-actions">
                <Button size="sm" variant="secondary" onClick={() => reply(selected, false)}>
                  <ArrowUturnLeftIcon aria-hidden="true" />
                  Yanıtla
                </Button>
                <Button size="sm" variant="ghost" onClick={() => reply(selected, true)}>
                  Tümünü yanıtla
                </Button>
                <Button size="sm" variant="ghost" onClick={() => forward(selected)}>
                  <ArrowUturnRightIcon aria-hidden="true" />
                  İlet
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void markUnread(selected.uid)}
                  title="Okunmadı olarak işaretle"
                >
                  <EnvelopeIcon aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void removeMessages([selected.uid])}
                  title="Sil"
                >
                  <TrashIcon aria-hidden="true" />
                </Button>
              </div>
            </header>

            <div className="wm-message-meta">
              <div>
                <strong>{displayName(selected.from)}</strong>
                {selected.from?.name && (
                  <span className="sp-mono wm-dim"> &lt;{selected.from.address}&gt;</span>
                )}
              </div>
              <div className="wm-dim">
                Kime: <span className="sp-mono">{selected.to.map((a) => a.address).join(", ")}</span>
                {selected.cc.length > 0 && (
                  <>
                    {" · Cc: "}
                    <span className="sp-mono">{selected.cc.map((a) => a.address).join(", ")}</span>
                  </>
                )}
              </div>
              <time className="wm-dim">{fullDate(selected.date)}</time>
            </div>

            {selected.attachments.length > 0 && (
              <ul className="wm-attachments">
                {selected.attachments.map((a) => (
                  <li key={a.index}>
                    <a
                      href={webmailApi.attachmentUrl(current, selected.uid, a.index)}
                      download={a.filename}
                    >
                      <PaperClipIcon aria-hidden="true" />
                      <span className="wm-attach-name">{a.filename}</span>
                      <span className="wm-attach-size sp-mono">{formatBytes(a.size)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}

            <MessageBody html={selected.html} text={selected.text} />
          </article>
        )}
      </section>

      {composer && (
        <div className="wm-composer-backdrop" onClick={(e) => e.target === e.currentTarget && setComposer(null)}>
          <Composer
            seed={composer}
            onClose={() => setComposer(null)}
            onSent={() => {
              setComposer(null);
              void loadMailboxes();
              void loadMessages(current, activeSearch);
            }}
          />
        </div>
      )}
    </div>
  );
}
