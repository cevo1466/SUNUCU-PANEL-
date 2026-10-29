/**
 * Webmail API istemcisi — panelin `lib/api.ts`'inden AYRI.
 *
 * NEDEN AYRI DOSYA: webmail farklı bir kimlik dünyası (posta kutusu, panel
 * kullanıcısı değil) ve farklı bir çerez kullanıyor. Aynı dosyada durmaları,
 * bir gün birinin ötekinin `request()` yardımcısını çağırıp yanlış oturumla
 * istek atmasını kolaylaştırırdı. Ayrı dosya bu karışıklığı zorlaştırır.
 */

export class WebmailApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body !== undefined && init.body !== null) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...init, credentials: "include", headers });
  const raw = await res.text();
  let body: unknown = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = { error: raw.slice(0, 300) };
    }
  }
  if (!res.ok) {
    throw new WebmailApiError(
      (body as { error?: string }).error ?? `İstek başarısız (${res.status})`,
      res.status,
    );
  }
  return body as T;
}

export interface Mailbox {
  path: string;
  label: string;
  role: "inbox" | "sent" | "drafts" | "trash" | "junk" | null;
  total: number;
  unseen: number;
}

export interface Quota {
  usedBytes: number | null;
  limitBytes: number | null;
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
}

export interface MessageDetail extends MessageSummary {
  cc: Array<{ name: string; address: string }>;
  html: string | null;
  text: string | null;
  attachments: Array<{ index: number; filename: string; contentType: string; size: number }>;
  messageId: string | null;
  references: string[];
}

export interface OutgoingDraft {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
}

export const webmailApi = {
  me: () =>
    request<{
      account: { address: string; domain_name: string; local_part: string; quota_mb: number | null } | null;
    }>("/api/webmail/me"),

  login: (address: string, password: string) =>
    request<{ ok: boolean; address: string }>("/api/webmail/login", {
      method: "POST",
      body: JSON.stringify({ address, password }),
    }),

  logout: () => request<{ ok: boolean }>("/api/webmail/logout", { method: "POST" }),

  mailboxes: () => request<{ mailboxes: Mailbox[]; quota: Quota }>("/api/webmail/mailboxes"),

  messages: (mailbox: string, options: { offset?: number; limit?: number; search?: string } = {}) => {
    const params = new URLSearchParams({ mailbox });
    if (options.offset) params.set("offset", String(options.offset));
    if (options.limit) params.set("limit", String(options.limit));
    if (options.search) params.set("search", options.search);
    return request<{ messages: MessageSummary[]; total: number; offset: number }>(
      `/api/webmail/messages?${params}`,
    );
  },

  message: (mailbox: string, uid: number) =>
    request<MessageDetail>(
      `/api/webmail/message?mailbox=${encodeURIComponent(mailbox)}&uid=${uid}`,
    ),

  attachmentUrl: (mailbox: string, uid: number, index: number) =>
    `/api/webmail/attachment?mailbox=${encodeURIComponent(mailbox)}&uid=${uid}&index=${index}`,

  flag: (mailbox: string, uids: number[], flag: "seen" | "flagged", add: boolean) =>
    request<{ ok: boolean }>("/api/webmail/flag", {
      method: "POST",
      body: JSON.stringify({ mailbox, uids, flag, add }),
    }),

  move: (mailbox: string, uids: number[], target: string) =>
    request<{ ok: boolean }>("/api/webmail/move", {
      method: "POST",
      body: JSON.stringify({ mailbox, uids, target }),
    }),

  remove: (mailbox: string, uids: number[]) =>
    request<{ ok: boolean; permanent: boolean }>("/api/webmail/delete", {
      method: "POST",
      body: JSON.stringify({ mailbox, uids }),
    }),

  send: (draft: OutgoingDraft) =>
    request<{ sent: boolean; savedToSent: boolean }>("/api/webmail/send", {
      method: "POST",
      body: JSON.stringify(draft),
    }),

  preview: (draft: Pick<OutgoingDraft, "subject" | "html" | "text">) =>
    request<{ html: string }>("/api/webmail/preview", {
      method: "POST",
      body: JSON.stringify(draft),
    }),

  saveDraft: (draft: OutgoingDraft) =>
    request<{ saved: boolean }>("/api/webmail/draft", {
      method: "POST",
      body: JSON.stringify(draft),
    }),
};

/** Dosyayı base64'e çevirir (ek gönderimi için). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} okunamadı.`));
    reader.onload = () => {
      const result = String(reader.result);
      // "data:<mime>;base64,XXXX" -> "XXXX"
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
