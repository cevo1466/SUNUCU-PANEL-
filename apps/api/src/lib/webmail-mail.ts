import { simpleParser, type Attachment } from "mailparser";
import nodemailer from "nodemailer";
import type { ImapFlow } from "imapflow";
import { env } from "../env.js";
import { withImap } from "./webmail-imap.js";
import type { WebmailIdentity } from "./webmail-session.js";

/**
 * Webmail'in posta işlemleri. IMAP/SMTP ayrıntısı burada kalır; route katmanı
 * yalnızca bu fonksiyonları çağırır.
 */

export class WebmailError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Özel klasörler — IMAP sunucusu bunları farklı adlarla verebilir. */
export interface MailboxInfo {
  /** IMAP'teki gerçek yol (INBOX, Sent, ...). İstemci bunu geri gönderir. */
  path: string;
  /** Kullanıcıya gösterilecek Türkçe ad. */
  label: string;
  /** Bilinen rol: gelen/gönderilen/taslak/çöp/spam. Bilinmiyorsa null. */
  role: "inbox" | "sent" | "drafts" | "trash" | "junk" | null;
  total: number;
  unseen: number;
}

const ROLE_LABELS: Record<NonNullable<MailboxInfo["role"]>, string> = {
  inbox: "Gelen kutusu",
  sent: "Gönderilenler",
  drafts: "Taslaklar",
  trash: "Çöp kutusu",
  junk: "Spam",
};

/**
 * Klasörün rolünü belirler.
 *
 * ÖZEL KULLANIM BAYRAKLARI ÖNCE (\Sent, \Trash gibi): RFC 6154 bunları tam da
 * bu iş için tanımlıyor ve ad tahminine göre çok daha güvenilir. Ad eşlemesi
 * yalnızca bayrak yoksa devreye girer — Dovecot varsayılan kurulumda bu
 * bayrakları her zaman vermiyor.
 */
function detectRole(path: string, specialUse?: string): MailboxInfo["role"] {
  switch (specialUse) {
    case "\\Sent":
      return "sent";
    case "\\Drafts":
      return "drafts";
    case "\\Trash":
      return "trash";
    case "\\Junk":
      return "junk";
    case "\\Inbox":
      return "inbox";
  }
  const name = path.toLowerCase();
  if (name === "inbox") return "inbox";
  if (/^(sent|sent items|gönderilmiş|gonderilmis|giden)/.test(name)) return "sent";
  if (/^(drafts?|taslak)/.test(name)) return "drafts";
  if (/^(trash|deleted|çöp|cop|silinen)/.test(name)) return "trash";
  if (/^(junk|spam)/.test(name)) return "junk";
  return null;
}

export async function listMailboxes(identity: WebmailIdentity): Promise<MailboxInfo[]> {
  return withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    const list = await client.list();
    const out: MailboxInfo[] = [];
    for (const box of list) {
      // \Noselect klasörleri yalnızca hiyerarşi taşıyıcısıdır, açılamaz.
      if (box.flags?.has("\\Noselect")) continue;
      const status = await client.status(box.path, { messages: true, unseen: true });
      const role = detectRole(box.path, box.specialUse);
      out.push({
        path: box.path,
        label: role ? ROLE_LABELS[role] : box.name,
        role,
        total: status.messages ?? 0,
        unseen: status.unseen ?? 0,
      });
    }
    // Bilinen roller sabit ve tanıdık bir sırada; gerisi alfabetik.
    const order: Array<MailboxInfo["role"]> = ["inbox", "drafts", "sent", "junk", "trash"];
    return out.sort((a, b) => {
      const ai = a.role ? order.indexOf(a.role) : 99;
      const bi = b.role ? order.indexOf(b.role) : 99;
      if (ai !== bi) return ai - bi;
      return a.label.localeCompare(b.label, "tr");
    });
  });
}

export interface MessageSummary {
  uid: number;
  subject: string;
  from: { name: string; address: string } | null;
  to: Array<{ name: string; address: string }>;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  size: number;
  /** İlk satırlardan üretilen kısa önizleme. */
  preview: string;
}

function addressOf(value: unknown): { name: string; address: string } | null {
  const list = (value as { value?: Array<{ name?: string; address?: string }> } | undefined)?.value;
  const first = list?.[0];
  if (!first?.address) return null;
  return { name: first.name || "", address: first.address };
}

function addressList(value: unknown): Array<{ name: string; address: string }> {
  const list = (value as { value?: Array<{ name?: string; address?: string }> } | undefined)?.value;
  return (list ?? [])
    .filter((a) => a.address)
    .map((a) => ({ name: a.name || "", address: a.address! }));
}

/**
 * Ek dosya var mı — GÖVDE İNDİRİLMEDEN, yalnızca BODYSTRUCTURE'dan.
 *
 * Liste ekranı için gövdeyi indirmek kabul edilemez: 50 mesajlık bir sayfada
 * her biri megabaytlarca olabilir. BODYSTRUCTURE zaten IMAP FETCH ile
 * geliyor ve eklerin varlığını söylemeye yetiyor.
 */
function hasAttachment(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { disposition?: string; childNodes?: unknown[] };
  if (n.disposition && n.disposition.toLowerCase() === "attachment") return true;
  return (n.childNodes ?? []).some((child) => hasAttachment(child));
}

export interface MessagePage {
  messages: MessageSummary[];
  total: number;
  /** Kaçıncı mesajdan başlandığı (0 tabanlı, en yeniden geriye). */
  offset: number;
}

/**
 * Bir klasördeki mesajları listeler — en yeniden eskiye.
 *
 * SAYFALAMA UID ARALIĞIYLA DEĞİL SIRA NUMARASIYLA: UID'ler seyrek olabilir
 * (silinen mesajlar boşluk bırakır), bu yüzden "son 50" demek için sıra
 * numarası aralığı doğru araçtır.
 */
export async function listMessages(
  identity: WebmailIdentity,
  mailbox: string,
  options: { offset?: number; limit?: number; search?: string } = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  return withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const box = client.mailbox;
      const total = typeof box === "object" ? box.exists : 0;

      let uids: number[];
      if (options.search && options.search.trim()) {
        // Arama dovecot'a devredilir. Konu, gönderen VE gövde birlikte
        // aranıyor: kullanıcı "aradığım kelime maildeydi" derken hangisinde
        // olduğunu bilmiyor.
        const term = options.search.trim();
        const found = await client.search({ or: [{ subject: term }, { from: term }, { body: term }] });
        uids = (found || []).slice().sort((a, b) => b - a);
      } else {
        if (total === 0) return { messages: [], total: 0, offset };
        // En yeniden geriye: sıra numarası aralığını hesapla.
        const end = total - offset;
        const start = Math.max(1, end - limit + 1);
        if (end < 1) return { messages: [], total, offset };
        const seq = `${start}:${end}`;
        const collected: number[] = [];
        for await (const msg of client.fetch(seq, { uid: true })) collected.push(msg.uid);
        uids = collected.sort((a, b) => b - a);
      }

      const pageUids = options.search ? uids.slice(offset, offset + limit) : uids;
      if (pageUids.length === 0) {
        return { messages: [], total: options.search ? uids.length : total, offset };
      }

      const messages: MessageSummary[] = [];
      for await (const msg of client.fetch(
        pageUids,
        { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
        { uid: true },
      )) {
        const env_ = msg.envelope;
        messages.push({
          uid: msg.uid,
          subject: env_?.subject || "(konu yok)",
          from: env_?.from?.[0]
            ? { name: env_.from[0].name || "", address: env_.from[0].address || "" }
            : null,
          to: (env_?.to ?? []).map((a) => ({ name: a.name || "", address: a.address || "" })),
          date: env_?.date ? new Date(env_.date).toISOString() : null,
          seen: msg.flags?.has("\\Seen") ?? false,
          flagged: msg.flags?.has("\\Flagged") ?? false,
          answered: msg.flags?.has("\\Answered") ?? false,
          hasAttachments: hasAttachment(msg.bodyStructure),
          size: msg.size ?? 0,
          preview: "",
        });
      }
      messages.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      return { messages, total: options.search ? uids.length : total, offset };
    } finally {
      lock.release();
    }
  });
}

export interface MessageDetail extends Omit<MessageSummary, "preview"> {
  cc: Array<{ name: string; address: string }>;
  /** Güvenli hale getirilmiş HTML gövde; yoksa null. */
  html: string | null;
  text: string | null;
  attachments: Array<{ index: number; filename: string; contentType: string; size: number }>;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

/**
 * Gelen HTML'i temizler.
 *
 * NEDEN ZORUNLU: mail gövdesi TAMAMEN güvenilmez girdidir; olduğu gibi
 * basmak birinci sınıf XSS'tir — saldırgan sadece mail göndererek webmail
 * oturumunu ele geçirebilirdi.
 *
 * Yaklaşım İZİN LİSTESİ DEĞİL, hedefli çıkarma + istemci tarafında sandbox:
 * burada script/iframe/object gibi çalıştırılabilir düğümler ve `on*`
 * öznitelikleri ile `javascript:` URL'leri sökülür; ayrıca gövde istemcide
 * `sandbox` iframe içinde gösterilir (bkz. web MessageBody bileşeni). İki
 * katman, çünkü tek bir regex temizliğine güvenmek yeterli değildir.
 *
 * Uzak görsel yüklemesi de engellenir (`src` -> `data-blocked-src`):
 * aksi halde mail açılır açılmaz gönderene "okundu" sinyali giden bir
 * izleme pikseli çalışırdı.
 */
export function sanitizeHtml(html: string): string {
  let out = html;
  out = out.replace(/<\s*(script|style|iframe|object|embed|applet|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/<\s*(script|iframe|object|embed|applet|link|meta|base)\b[^>]*\/?>/gi, "");
  // on* olay öznitelikleri (tırnaklı ve tırnaksız).
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  // javascript:/vbscript: ve data: (svg+html taşıyabilir) URL'leri.
  out = out.replace(/(href|src|action|formaction)\s*=\s*(["'])\s*(javascript|vbscript|data)\s*:[^"']*\2/gi, '$1="#"');
  // Uzak görseller: yüklenmesin ama kullanıcı isterse gösterebilelim.
  out = out.replace(/\ssrc\s*=\s*(["'])(https?:\/\/[^"']*)\1/gi, ' data-blocked-src=$1$2$1');
  out = out.replace(/\ssrcset\s*=\s*(["'])[^"']*\1/gi, "");
  return out;
}

export async function readMessage(
  identity: WebmailIdentity,
  mailbox: string,
  uid: number,
): Promise<MessageDetail> {
  return withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      // fetchOne mesaj yoksa `false` döner (throw etmez); tip daraltması şart.
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true, size: true, source: true },
        { uid: true },
      );
      if (!msg || typeof msg === "boolean" || !msg.source) {
        throw new WebmailError("Mesaj bulunamadı.", 404);
      }

      const parsed = await simpleParser(msg.source);
      // Okundu işaretle — kullanıcı mesajı gerçekten açtı.
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {});

      const atts = (parsed.attachments ?? []) as Attachment[];
      return {
        uid,
        subject: parsed.subject || "(konu yok)",
        from: addressOf(parsed.from),
        to: addressList(parsed.to),
        cc: addressList(parsed.cc),
        date: parsed.date ? parsed.date.toISOString() : null,
        seen: true,
        flagged: msg.flags?.has("\\Flagged") ?? false,
        answered: msg.flags?.has("\\Answered") ?? false,
        hasAttachments: atts.length > 0,
        size: msg.size ?? 0,
        html: parsed.html ? sanitizeHtml(parsed.html) : null,
        text: parsed.text ?? null,
        attachments: atts.map((a, index) => ({
          index,
          filename: a.filename || `ek-${index + 1}`,
          contentType: a.contentType || "application/octet-stream",
          size: a.size ?? 0,
        })),
        messageId: parsed.messageId ?? null,
        inReplyTo: (parsed.inReplyTo as string | undefined) ?? null,
        references: Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [],
      };
    } finally {
      lock.release();
    }
  });
}

/** Tek bir eki ham haliyle döndürür (indirme için). */
export async function fetchAttachment(
  identity: WebmailIdentity,
  mailbox: string,
  uid: number,
  index: number,
): Promise<{ filename: string; contentType: string; content: Buffer }> {
  return withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!msg || typeof msg === "boolean" || !msg.source) {
        throw new WebmailError("Mesaj bulunamadı.", 404);
      }
      const parsed = await simpleParser(msg.source);
      const att = (parsed.attachments ?? [])[index];
      if (!att) throw new WebmailError("Ek bulunamadı.", 404);
      return {
        filename: att.filename || `ek-${index + 1}`,
        contentType: att.contentType || "application/octet-stream",
        content: att.content as Buffer,
      };
    } finally {
      lock.release();
    }
  });
}

/** Kota — dovecot'un QUOTA eklentisinden; tahmin edilmez. */
export async function readQuota(
  identity: WebmailIdentity,
): Promise<{ usedBytes: number | null; limitBytes: number | null }> {
  return withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    try {
      const q = await client.getQuota();
      if (!q || typeof q === "boolean" || !q.storage) return { usedBytes: null, limitBytes: null };
      // DİKKAT — TİP YALAN SÖYLÜYOR. imapflow'un tip tanımı alanı `used` diye
      // bildiriyor ama çalışma zamanında dönen nesne `usage`:
      //   {"path":"INBOX","storage":{"usage":3072,"limit":104857600}}
      // `q.storage.used` yazmak DERLENİYOR ve sessizce undefined veriyordu;
      // kullanıcı kotasının doldurulmuş halini hiç göremiyordu. İkisi de
      // okunuyor: kütüphane tipiyle gerçeği hizalarsa da çalışmaya devam etsin.
      const storage = q.storage as unknown as { usage?: number; used?: number; limit?: number };
      return {
        usedBytes: storage.usage ?? storage.used ?? null,
        limitBytes: storage.limit ?? null,
      };
    } catch {
      // QUOTA eklentisi kapalıysa uydurma değer döndürmüyoruz.
      return { usedBytes: null, limitBytes: null };
    }
  });
}

export async function setFlag(
  identity: WebmailIdentity,
  mailbox: string,
  uids: number[],
  flag: "\\Seen" | "\\Flagged",
  add: boolean,
): Promise<void> {
  if (uids.length === 0) return;
  await withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const list = uids.join(",");
      if (add) await client.messageFlagsAdd(list, [flag], { uid: true });
      else await client.messageFlagsRemove(list, [flag], { uid: true });
    } finally {
      lock.release();
    }
  });
}

/**
 * Mesajı başka klasöre taşır. Silme de budur: hedef çöp kutusudur.
 *
 * GERÇEK SİLME AYRI BİR İŞ: çöp kutusundan silinen mesaj gerçekten yok edilir
 * (`expunge`). "Sil" düğmesinin bir kere çöpe atıp bir daha yok etmesi,
 * kullanıcının beklediği davranış — tek adımda kalıcı silmek veri kaybıdır.
 */
export async function moveMessages(
  identity: WebmailIdentity,
  mailbox: string,
  uids: number[],
  targetMailbox: string,
): Promise<void> {
  if (uids.length === 0) return;
  await withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageMove(uids.join(","), targetMailbox, { uid: true });
    } finally {
      lock.release();
    }
  });
}

export async function deleteMessagesPermanently(
  identity: WebmailIdentity,
  mailbox: string,
  uids: number[],
): Promise<void> {
  if (uids.length === 0) return;
  await withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageDelete(uids.join(","), { uid: true });
    } finally {
      lock.release();
    }
  });
}

export interface OutgoingMessage {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** Zengin metin editöründen gelen HTML. */
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
}

/**
 * Mail gönderir ve kopyasını Gönderilenler'e yazar.
 *
 * KOPYA NEDEN AYRI ADIM: SMTP gönderimi mesajı IMAP'e koymaz — bu iki ayrı
 * protokol. Kopyayı biz yazmazsak kullanıcı gönderdiği maili hiçbir yerde
 * göremez ve "gitti mi?" diye sorar. Kopya yazımı BAŞARISIZ olsa bile
 * gönderim başarılı sayılır (mail gerçekten gitti); durum çağırana bildirilir.
 */
export async function sendMessage(
  identity: WebmailIdentity,
  message: OutgoingMessage,
): Promise<{ sent: true; savedToSent: boolean }> {
  const transport = nodemailer.createTransport({
    host: env.WEBMAIL_SMTP_HOST,
    port: env.WEBMAIL_SMTP_PORT,
    // 587 STARTTLS ile başlar; sertifika kendinden imzalı ve bağlantı
    // loopback olduğu için doğrulama kapalı (bkz. webmail-imap.ts aynı gerekçe).
    secure: false,
    requireTLS: false,
    tls: { rejectUnauthorized: false },
    auth: { user: identity.address, pass: identity.password },
  });

  const built = {
    from: identity.address,
    to: message.to,
    cc: message.cc || undefined,
    bcc: message.bcc || undefined,
    subject: message.subject,
    html: message.html || undefined,
    text: message.text || undefined,
    inReplyTo: message.inReplyTo || undefined,
    references: message.references?.length ? message.references : undefined,
    attachments: message.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };

  // MIME BİR KEZ KURULUR, İKİ YERE GİDER.
  //
  // NEDEN ÖNCE İNŞA EDİP SONRA GÖNDERİYORUZ: nodemailer'ın SMTP taşıyıcısı
  // dönen `info` içinde ham mesajı VERMEZ — o alan yalnızca streamTransport'ta
  // dolu. Doğrudan `sendMail(built)` çağrıldığında elimizde Gönderilenler'e
  // yazacak bir şey kalmıyordu ve kopya sessizce atlanıyordu (ilk testte
  // `savedToSent: false` tam olarak buydu).
  //
  // Aynı baytların hem gönderilip hem saklanması ayrıca DOĞRU olan: kullanıcı
  // Gönderilenler'de, karşı tarafın aldığının birebir aynısını görür — yeniden
  // kurulmuş, sınır dizileri ve Message-ID'si farklı bir kopyayı değil.
  let raw: Buffer;
  try {
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const composed = await builder.sendMail(built);
    const message_ = (composed as { message?: Buffer }).message;
    if (!message_) throw new Error("MIME oluşturulamadı.");
    raw = message_;
  } catch (err) {
    transport.close();
    throw new WebmailError(`Mail hazırlanamadı: ${(err as Error).message}`, 500);
  }

  // Zarf açıkça veriliyor: ham mesaj gönderilirken nodemailer başlıklardan
  // alıcı çıkarmaz. Bcc de buraya girer (başlıkta görünmez, zarfta gider).
  const envelopeTo = [message.to, message.cc, message.bcc]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  try {
    await transport.sendMail({
      envelope: { from: identity.address, to: envelopeTo },
      raw,
    });
  } catch (err) {
    throw new WebmailError(`Mail gönderilemedi: ${(err as Error).message}`, 502);
  } finally {
    transport.close();
  }

  let savedToSent = false;
  try {
    const boxes = await listMailboxes(identity);
    const sentBox = boxes.find((b) => b.role === "sent");
    if (sentBox) {
      await withImap(identity.sessionId, identity.address, identity.password, async (client) => {
        await client.append(sentBox.path, raw, ["\\Seen"]);
      });
      savedToSent = true;
    }
  } catch {
    // Gönderim zaten başarılı; kopya yazılamadıysa bunu yalan söylemeden
    // çağırana bildiriyoruz.
    savedToSent = false;
  }

  return { sent: true, savedToSent };
}

/** Taslak kaydeder (Taslaklar klasörüne APPEND). */
export async function saveDraft(
  identity: WebmailIdentity,
  message: OutgoingMessage,
): Promise<{ saved: boolean }> {
  const boxes = await listMailboxes(identity);
  const drafts = boxes.find((b) => b.role === "drafts");
  if (!drafts) return { saved: false };

  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: identity.address,
    to: message.to || undefined,
    cc: message.cc || undefined,
    subject: message.subject,
    html: message.html || undefined,
    text: message.text || undefined,
  });
  const raw = (info as { message?: Buffer }).message;
  if (!raw) return { saved: false };

  await withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    await client.append(drafts.path, raw, ["\\Draft", "\\Seen"]);
  });
  return { saved: true };
}

/** Eksik özel klasörleri oluşturur (Sent/Drafts/Trash yoksa). */
export async function ensureStandardMailboxes(identity: WebmailIdentity): Promise<void> {
  const boxes = await listMailboxes(identity);
  const missing: Array<{ name: string; role: MailboxInfo["role"] }> = [];
  if (!boxes.some((b) => b.role === "sent")) missing.push({ name: "Sent", role: "sent" });
  if (!boxes.some((b) => b.role === "drafts")) missing.push({ name: "Drafts", role: "drafts" });
  if (!boxes.some((b) => b.role === "trash")) missing.push({ name: "Trash", role: "trash" });
  if (missing.length === 0) return;

  await withImap(identity.sessionId, identity.address, identity.password, async (client) => {
    for (const box of missing) {
      await client.mailboxCreate(box.name).catch(() => {});
    }
  });
}

/** Route katmanının IMAP hatalarını kullanıcıya çevirmesi için. */
export function toWebmailError(err: unknown): WebmailError {
  if (err instanceof WebmailError) return err;
  const message = (err as Error)?.message ?? "Bilinmeyen hata";
  if (/auth/i.test(message)) return new WebmailError("Kimlik doğrulanamadı.", 401);
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(message)) {
    return new WebmailError("Posta sunucusuna ulaşılamıyor.", 503);
  }
  return new WebmailError(`Posta işlemi başarısız: ${message}`, 502);
}

export type { ImapFlow };
