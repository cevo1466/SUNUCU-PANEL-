import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { env } from "../env.js";

/**
 * Oturum başına IMAP bağlantı havuzu.
 *
 * NEDEN HAVUZ (yaklaşım B): her API isteğinde yeni bağlantı açmak TCP + TLS +
 * LOGIN demek. Ölçülebilir bir gecikme (yerelde bile ~100 ms) ve dovecot'ta
 * gereksiz süreç trafiği. Kullanıcı listeden bir maile, oradan sonrakine
 * geçerken bunu tek tek ödüyordu. Havuz aynı bağlantıyı tekrar kullanır.
 *
 * NEDEN SINIRLI VE SÜRELİ: bir bağlantı havuzu, temizlenmezse sızıntıdır.
 * Bu projede aynı ders daha önce süreçlerde öğrenildi (sahipsiz kalan
 * gözetmenler portu tutuyordu). Burada üç kapı var:
 *   - boşta kalan bağlantı IDLE_TIMEOUT_MS sonra kapanır,
 *   - toplam bağlantı MAX_CONNECTIONS'ı aşamaz (aşınca en eski boşta olan
 *     kapatılır),
 *   - çıkışta oturumun bağlantısı açıkça kapatılır.
 * Ayrıca `logout()` çağrılmadan süreç ölse bile dovecot kendi tarafında
 * bağlantıyı düşürür; bu sadece iyi komşuluk, tek savunma değil.
 */

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONNECTIONS = 40;
/** Bir IMAP işleminin tavan süresi; asılı kalan bağlantı isteği kilitlemesin. */
const OPERATION_TIMEOUT_MS = 30_000;

interface PooledConnection {
  client: ImapFlow;
  lastUsed: number;
  /** Aynı bağlantı üzerinde eşzamanlı komut çalıştırılamaz; işlemler sıraya girer. */
  chain: Promise<unknown>;
}

const pool = new Map<string, PooledConnection>();
let sweeper: NodeJS.Timeout | null = null;

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, conn] of pool) {
      if (now - conn.lastUsed > IDLE_TIMEOUT_MS) {
        pool.delete(key);
        void conn.client.logout().catch(() => {});
      }
    }
    if (pool.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 60_000);
  // Süpürücü Node'un kapanmasını engellemesin (self-test'ler asılı kalırdı).
  sweeper.unref?.();
}

function imapOptions(address: string, password: string): ImapFlowOptions {
  return {
    host: env.WEBMAIL_IMAP_HOST,
    port: env.WEBMAIL_IMAP_PORT,
    // 143 + STARTTLS varsayılan. Sertifika kendinden imzalı olduğu ve bağlantı
    // 127.0.0.1 üzerinden gittiği için doğrulama kapalı: doğrulamayı açık
    // bırakmak her girişi "self signed certificate" ile düşürürdü, sertifikayı
    // güvenilir kök yapmak ise loopback için gereksiz bir tören.
    secure: env.WEBMAIL_IMAP_PORT === 993,
    tls: { rejectUnauthorized: !["127.0.0.1", "localhost", "::1"].includes(env.WEBMAIL_IMAP_HOST) },
    auth: { user: address, pass: password },
    logger: false,
    // Kendi zaman aşımımız var; imapflow'unki daha uzun olabiliyor.
    socketTimeout: OPERATION_TIMEOUT_MS,
  };
}

/**
 * Kimlik doğrular. Havuza GİRMEZ — yalnızca "bu parola doğru mu" sorusunu
 * dovecot'a sorar ve bağlantıyı kapatır.
 *
 * NEDEN parolayı kendimiz doğrulamıyoruz: `mail_accounts.password_hash` bir
 * SHA512-CRYPT değeri ve doğrulamayı biz de yapabilirdik. Ama IMAP'e sormak
 * DAHA GÜÇLÜ bir garanti veriyor: hesabın gerçekten posta kutusuna
 * girebildiğini kanıtlıyor. Hash doğru olup dovecot passwd dosyası güncel
 * olmasaydı (panel yazmayı unutsa, mail-ctl reload edilmemiş olsa) kendi
 * doğrulamamız "giriş başarılı" der, kullanıcı boş bir webmail görürdü.
 */
export async function verifyImapLogin(address: string, password: string): Promise<boolean> {
  const client = new ImapFlow(imapOptions(address, password));
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch {
    try {
      client.close();
    } catch {
      /* zaten kapalı */
    }
    return false;
  }
}

async function evictOldestIdle(): Promise<void> {
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [key, conn] of pool) {
    if (conn.lastUsed < oldest) {
      oldest = conn.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const conn = pool.get(oldestKey)!;
    pool.delete(oldestKey);
    await conn.client.logout().catch(() => {});
  }
}

async function acquire(
  sessionId: string,
  address: string,
  password: string,
): Promise<PooledConnection> {
  const existing = pool.get(sessionId);
  if (existing && existing.client.usable) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) {
    // Bağlantı kopmuş; yenisini açmadan önce kaydı düşür.
    pool.delete(sessionId);
    void existing.client.logout().catch(() => {});
  }
  if (pool.size >= MAX_CONNECTIONS) await evictOldestIdle();

  const client = new ImapFlow(imapOptions(address, password));
  await client.connect();
  const conn: PooledConnection = { client, lastUsed: Date.now(), chain: Promise.resolve() };
  pool.set(sessionId, conn);
  startSweeper();
  return conn;
}

/**
 * Havuzdan bir bağlantı alıp `fn`'i çalıştırır.
 *
 * İşlemler aynı bağlantı üzerinde SIRAYA GİRER (`chain`). IMAP tek kanaldır;
 * iki komutu paralel göndermek protokolü bozar. Kullanıcı arayüzde hızlıca
 * iki şeye tıkladığında bu gerçekten oluyor.
 */
export async function withImap<T>(
  sessionId: string,
  address: string,
  password: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const conn = await acquire(sessionId, address, password);
  const run = conn.chain.then(
    () => fn(conn.client),
    () => fn(conn.client),
  );
  // Zincir hiçbir zaman reddedilmiş halde kalmamalı; aksi halde sonraki
  // işlemler de reddedilirdi.
  conn.chain = run.catch(() => undefined);
  try {
    const result = await run;
    conn.lastUsed = Date.now();
    return result;
  } catch (err) {
    conn.lastUsed = Date.now();
    // Bağlantı kullanılamaz hale geldiyse havuzdan at ki bir sonraki istek
    // yenisini açsın — bozuk bağlantıyı saklamak kullanıcıyı kalıcı hataya
    // kilitlerdi.
    if (!conn.client.usable) {
      pool.delete(sessionId);
      void conn.client.logout().catch(() => {});
    }
    throw err;
  }
}

/** Çıkışta çağrılır. Bağlantı yoksa sessizce geçer. */
export async function releaseImap(sessionId: string): Promise<void> {
  const conn = pool.get(sessionId);
  if (!conn) return;
  pool.delete(sessionId);
  await conn.client.logout().catch(() => {});
}

/** Test ve kapanış için: tüm bağlantıları kapatır. */
export async function closeAllImap(): Promise<void> {
  const conns = [...pool.values()];
  pool.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  await Promise.all(conns.map((c) => c.client.logout().catch(() => {})));
}

/** İzleme/test için havuz boyutu. */
export function imapPoolSize(): number {
  return pool.size;
}
