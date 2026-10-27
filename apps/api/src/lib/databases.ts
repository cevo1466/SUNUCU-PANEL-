import crypto from "node:crypto";
import net from "node:net";
import type { Pool } from "pg";
import { env } from "../env.js";
import { isPortOpen } from "./net.js";

/**
 * Domain başına veritabanı yönetimi — PostgreSQL ve MySQL/MariaDB.
 *
 * İki motor, tek arayüz. PostgreSQL yolu panelin kendi çalıştırdığı gömülü
 * sunucuyu kullanır ve bu konteynerde gerçekten çalışır. MySQL yolu tam
 * yazılmıştır ama sunucu kurulu değilse `available:false` döner ve panel bunu
 * açıkça söyler — "kurulmuş gibi" davranmaz. Aynı dürüstlük kuralı FTP
 * (pureFtpdStatus) ve SSL (certbot) tarafında da uygulanıyor.
 */

export class DatabaseError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export type DbEngine = "postgres" | "mysql";

export interface PanelDatabaseRow {
  id: number;
  domain_id: number;
  engine: DbEngine;
  db_name: string;
  db_user: string;
  created_at: Date;
}

/**
 * Tanımlayıcı kuralları.
 *
 * BU REGEX GÜVENLİK SINIRI. Veritabanı ve rol adları SQL'de parametre
 * (`$1`) olarak verilemez — `CREATE DATABASE $1` diye bir şey yok, ad
 * doğrudan sorgu metnine girmek zorunda. Dolayısıyla tek savunma, adın
 * ne olabileceğini daraltmaktır: küçük harfle başlar, yalnızca küçük harf,
 * rakam ve alt çizgi. Tırnak, boşluk, noktalı virgül, ters eğik çizgi ve
 * çok baytlı karakterlerin hiçbiri geçemez.
 *
 * 63 karakter sınırı PostgreSQL'in NAMEDATALEN'inden gelir; MySQL 64'e izin
 * verir ama iki motorda aynı adı kullanabilmek için dar olan seçildi.
 */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Panelin kendi tabloları asla kullanıcıya açılmaz. */
const RESERVED_NAMES = new Set([
  "postgres",
  "template0",
  "template1",
  "mysql",
  "information_schema",
  "performance_schema",
  "sys",
  "studio",
  "studio_panel",
]);

export function assertValidIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new DatabaseError(
      `${label} küçük harfle başlamalı; en fazla 63 karakter, yalnızca küçük harf, rakam ve _ içerebilir.`,
      400,
    );
  }
  if (RESERVED_NAMES.has(value)) {
    throw new DatabaseError(`"${value}" ayrılmış bir addır, kullanılamaz.`, 400);
  }
}

/**
 * Tanımlayıcıyı tırnak içine alır.
 *
 * Regex zaten tırnak içeren adı geçirmiyor; bu ikinci kat, regex ileride
 * gevşetilirse diye duruyor. PostgreSQL çift tırnak, MySQL backtick kullanır;
 * her ikisinde de kaçış, karakteri ikizlemektir.
 */
function quoteIdent(value: string, engine: DbEngine): string {
  if (engine === "postgres") return `"${value.replace(/"/g, '""')}"`;
  return `\`${value.replace(/`/g, "``")}\``;
}

/** Parola string literal olarak gider; tek tırnak ikizlenerek kaçırılır. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function generateDbPassword(): string {
  // Tırnak, ters eğik çizgi ve kabuk anlamı olan karakterler bilerek dışarıda:
  // parola bağlantı dizelerine ve yapılandırma dosyalarına elle kopyalanacak.
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(24);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Domain adından okunabilir bir varsayılan taban ad türetir. */
export function suggestDbName(domainName: string): string {
  const base = domainName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 50);
  const safe = /^[a-z]/.test(base) ? base : `db_${base}`;
  return safe.slice(0, 55);
}

/* ------------------------------------------------------------------ */
/* Motor bağlantı ayarları                                             */
/* ------------------------------------------------------------------ */

export interface EngineConnection {
  host: string;
  port: number;
}

export function postgresConnection(): EngineConnection {
  // Panelin kendi DATABASE_URL'i ile aynı sunucu — kullanıcı veritabanları da
  // orada açılır. Ayrı bir sunucu kurmak bu konteynerde mümkün değil.
  const url = new URL(env.DATABASE_URL);
  return { host: url.hostname, port: Number(url.port || 5432) };
}

export function mysqlConnection(): EngineConnection {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
  };
}

export interface EngineStatus {
  engine: DbEngine;
  /** Gerçek sunucu etiketi: "MySQL"/"MariaDB"/"PostgreSQL". `mysql` motoru
   * için port açıksa `SELECT VERSION()` ile belirlenir, kapalıysa `null`. */
  label: string | null;
  available: boolean;
  host: string;
  port: number;
  note: string;
}

/** Port açıksa `SELECT VERSION()` çalıştırıp gerçek motoru ("MariaDB" mi
 * "MySQL" mu) ayırt eder. Sürücü/bağlantı hatasında `null` döner — panel
 * bu durumda jenerik "MySQL/MariaDB" etiketine düşer, uydurma bir isim
 * göstermez. */
async function detectMysqlVariant(): Promise<string | null> {
  try {
    const mysql = await import("mysql2/promise");
    const { host, port } = mysqlConnection();
    const user = process.env.MYSQL_ADMIN_USER ?? "root";
    const password = process.env.MYSQL_ADMIN_PASSWORD ?? "";
    const connection = await mysql.createConnection({ host, port, user, password });
    try {
      const [rows] = await connection.query("SELECT VERSION() AS v");
      const version = (rows as Array<{ v: string }>)[0]?.v ?? "";
      return /mariadb/i.test(version) ? "MariaDB" : "MySQL";
    } finally {
      await connection.end().catch(() => {});
    }
  } catch {
    return null;
  }
}

export async function engineStatuses(pg: Pool): Promise<EngineStatus[]> {
  const pgConn = postgresConnection();
  const myConn = mysqlConnection();

  // PostgreSQL için port açık olması yetmez, panelin havuzu gerçekten sorgu
  // çalıştırabiliyor mu ona bakıyoruz.
  let pgOk = false;
  try {
    await pg.query("SELECT 1");
    pgOk = true;
  } catch {
    pgOk = false;
  }

  const myOk = await isPortOpen(myConn.host, myConn.port);
  const myLabel = myOk ? await detectMysqlVariant() : null;

  return [
    {
      engine: "postgres",
      label: pgOk ? "PostgreSQL" : null,
      available: pgOk,
      host: pgConn.host,
      port: pgConn.port,
      note: pgOk
        ? "Panelin gömülü PostgreSQL 16 sunucusu."
        : "PostgreSQL sunucusuna ulaşılamıyor.",
    },
    {
      engine: "mysql",
      label: myLabel,
      available: myOk,
      host: myConn.host,
      port: myConn.port,
      note: myOk
        ? `${myLabel ?? "MySQL/MariaDB"} sunucusu yanıt veriyor.`
        : `${myConn.host}:${myConn.port} dinlenmiyor. MariaDB kurulu değil; kurulumu root ister (apk add mariadb mariadb-client).`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Motor işlemleri                                                     */
/* ------------------------------------------------------------------ */

interface EngineOps {
  create(dbName: string, dbUser: string, password: string): Promise<void>;
  setPassword(dbUser: string, password: string): Promise<void>;
  drop(dbName: string, dbUser: string): Promise<void>;
}

function postgresOps(pg: Pool): EngineOps {
  const ident = (v: string) => quoteIdent(v, "postgres");

  return {
    async create(dbName, dbUser, password) {
      // Rol önce: veritabanının sahibi olacak.
      await pg.query(`CREATE ROLE ${ident(dbUser)} LOGIN PASSWORD ${quoteLiteral(password)}`);
      try {
        // CREATE DATABASE transaction içinde çalışamaz; havuzdan tek sorgu.
        await pg.query(`CREATE DATABASE ${ident(dbName)} OWNER ${ident(dbUser)}`);
      } catch (err) {
        // Veritabanı açılamadıysa yarım kalmış rolü bırakmıyoruz.
        await pg.query(`DROP ROLE IF EXISTS ${ident(dbUser)}`).catch(() => {});
        throw err;
      }
      await pg.query(
        `GRANT ALL PRIVILEGES ON DATABASE ${ident(dbName)} TO ${ident(dbUser)}`,
      );
    },

    async setPassword(dbUser, password) {
      await pg.query(`ALTER ROLE ${ident(dbUser)} WITH PASSWORD ${quoteLiteral(password)}`);
    },

    async drop(dbName, dbUser) {
      // Açık bağlantılar DROP DATABASE'i engeller; önce onları kesiyoruz.
      await pg
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        )
        .catch(() => {});
      await pg.query(`DROP DATABASE IF EXISTS ${ident(dbName)}`);
      await pg.query(`DROP ROLE IF EXISTS ${ident(dbUser)}`);
    },
  };
}

/**
 * MySQL bağlantısı yalnızca gerçekten gerektiğinde kurulur ve hemen kapanır:
 * sunucu çoğu kurulumda yok, sürekli açık bir havuz tutmak anlamsız.
 *
 * `mysql2` dinamik import ediliyor — sürücü, sunucu kurulu olmasa da paket
 * olarak var, ama modülü sunucuya hiç ihtiyaç duyulmayan bir açılışta
 * yüklemenin gereği yok.
 */
async function withMysql<T>(fn: (conn: MysqlConnectionLike) => Promise<T>): Promise<T> {
  const { host, port } = mysqlConnection();
  const user = process.env.MYSQL_ADMIN_USER ?? "root";
  const password = process.env.MYSQL_ADMIN_PASSWORD ?? "";

  let mysql: typeof import("mysql2/promise");
  try {
    mysql = await import("mysql2/promise");
  } catch {
    throw new DatabaseError("MySQL sürücüsü yüklenemedi.", 500);
  }

  let connection: MysqlConnectionLike;
  try {
    connection = (await mysql.createConnection({
      host,
      port,
      user,
      password,
      multipleStatements: false,
    })) as unknown as MysqlConnectionLike;
  } catch (err) {
    throw new DatabaseError(
      `MySQL sunucusuna bağlanılamadı (${host}:${port}). Sunucu kurulu ve MYSQL_ADMIN_USER/MYSQL_ADMIN_PASSWORD tanımlı olmalı. ${
        err instanceof Error ? err.message : String(err)
      }`,
      503,
    );
  }

  try {
    return await fn(connection);
  } finally {
    await connection.end().catch(() => {});
  }
}

interface MysqlConnectionLike {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

function mysqlOps(): EngineOps {
  const ident = (v: string) => quoteIdent(v, "mysql");

  return {
    async create(dbName, dbUser, password) {
      await withMysql(async (conn) => {
        await conn.query(
          `CREATE DATABASE ${ident(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        );
        try {
          // Kullanıcı yalnızca localhost'tan bağlanabilir: panelin açtığı
          // veritabanı internete açık bir hesapla gelmez.
          await conn.query(
            `CREATE USER ${ident(dbUser)}@'localhost' IDENTIFIED BY ${quoteLiteral(password)}`,
          );
          await conn.query(
            `GRANT ALL PRIVILEGES ON ${ident(dbName)}.* TO ${ident(dbUser)}@'localhost'`,
          );
          await conn.query("FLUSH PRIVILEGES");
        } catch (err) {
          await conn.query(`DROP DATABASE IF EXISTS ${ident(dbName)}`).catch(() => {});
          throw err;
        }
      });
    },

    async setPassword(dbUser, password) {
      await withMysql(async (conn) => {
        await conn.query(
          `ALTER USER ${ident(dbUser)}@'localhost' IDENTIFIED BY ${quoteLiteral(password)}`,
        );
        await conn.query("FLUSH PRIVILEGES");
      });
    },

    async drop(dbName, dbUser) {
      await withMysql(async (conn) => {
        await conn.query(`DROP DATABASE IF EXISTS ${ident(dbName)}`);
        await conn.query(`DROP USER IF EXISTS ${ident(dbUser)}@'localhost'`);
        await conn.query("FLUSH PRIVILEGES");
      });
    },
  };
}

function opsFor(engine: DbEngine, pg: Pool): EngineOps {
  return engine === "postgres" ? postgresOps(pg) : mysqlOps();
}

/* ------------------------------------------------------------------ */
/* Panel seviyesi işlemler (DB kaydı + gerçek motor işlemi birlikte)   */
/* ------------------------------------------------------------------ */

export interface CreatedDatabase {
  row: PanelDatabaseRow;
  /** Yalnızca burada, bir kez döner. Hiçbir yere kaydedilmez. */
  password: string;
  connection: EngineConnection;
}

/**
 * Veritabanını GERÇEKTEN oluşturur ve panel kaydını yazar.
 *
 * Sıra önemli: önce motorda oluşturulur, sonra panel satırı yazılır. Ters
 * olsaydı motor işlemi patladığında panelde var olmayan bir veritabanı
 * görünürdü. Panel satırı yazılamazsa motordaki nesneler geri alınır.
 */
/** En az 8 karakter; parola SQL literal ve bağlantı dizesine gireceği için
 * tırnak/ters eğik çizgi gibi kaçış gerektiren karakterler reddedilir —
 * generateDbPassword()'un ürettiği alfabeyle aynı güvenlik sınırı. */
const PASSWORD_PATTERN = /^[A-Za-z0-9!@#$%^&*_+=-]{8,72}$/;

export async function createDatabase(
  pg: Pool,
  params: { domainId: number; engine: DbEngine; dbName: string; dbUser: string; password?: string },
): Promise<CreatedDatabase> {
  const { domainId, engine, dbName, dbUser } = params;
  assertValidIdentifier(dbName, "Veritabanı adı");
  assertValidIdentifier(dbUser, "Kullanıcı adı");
  if (params.password !== undefined && !PASSWORD_PATTERN.test(params.password)) {
    throw new DatabaseError(
      "Parola 8-72 karakter olmalı ve yalnızca harf, rakam, !@#$%^&*_+=- içerebilir.",
      400,
    );
  }

  const existing = await pg.query(
    "SELECT id FROM panel_databases WHERE engine = $1 AND (db_name = $2 OR db_user = $3)",
    [engine, dbName, dbUser],
  );
  if (existing.rows.length > 0) {
    throw new DatabaseError("Bu ad veya kullanıcı bu motorda zaten kullanılıyor.", 409);
  }

  const password = params.password ?? generateDbPassword();
  const ops = opsFor(engine, pg);

  try {
    await ops.create(dbName, dbUser, password);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `Veritabanı oluşturulamadı: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  try {
    const { rows } = await pg.query<PanelDatabaseRow>(
      `INSERT INTO panel_databases (domain_id, engine, db_name, db_user)
         VALUES ($1, $2, $3, $4)
         RETURNING id, domain_id, engine, db_name, db_user, created_at`,
      [domainId, engine, dbName, dbUser],
    );
    return {
      row: rows[0],
      password,
      connection: engine === "postgres" ? postgresConnection() : mysqlConnection(),
    };
  } catch (err) {
    // Panel kaydı yazılamadı: motorda öksüz veritabanı bırakmıyoruz.
    await ops.drop(dbName, dbUser).catch(() => {});
    throw new DatabaseError(
      `Veritabanı kaydı yazılamadı: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}

/** Parolayı GERÇEKTEN değiştirir. Yeni parola bir kez döner, saklanmaz.
 * `desiredPassword` verilirse (kullanıcı kendi parolasını seçtiyse) o
 * kullanılır, yoksa otomatik üretilir. */
export async function resetDatabasePassword(
  pg: Pool,
  row: PanelDatabaseRow,
  desiredPassword?: string,
): Promise<{ password: string; connection: EngineConnection }> {
  if (desiredPassword !== undefined && !PASSWORD_PATTERN.test(desiredPassword)) {
    throw new DatabaseError(
      "Parola 8-72 karakter olmalı ve yalnızca harf, rakam, !@#$%^&*_+=- içerebilir.",
      400,
    );
  }
  const password = desiredPassword ?? generateDbPassword();
  const ops = opsFor(row.engine, pg);
  try {
    await ops.setPassword(row.db_user, password);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `Parola değiştirilemedi: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
  return {
    password,
    connection: row.engine === "postgres" ? postgresConnection() : mysqlConnection(),
  };
}

/**
 * Veritabanını GERÇEKTEN düşürür ve panel kaydını siler.
 *
 * Panel kaydı önce silinir: motor işlemi başarısız olsa bile panelde
 * "silindi" görünen bir kayıt kalmasın diye değil — tersi. Motor işlemi
 * başarısızsa hata yükselir ve kayıt silinmez, böylece panel gerçeği gösterir.
 */
export async function dropDatabase(pg: Pool, row: PanelDatabaseRow): Promise<void> {
  const ops = opsFor(row.engine, pg);
  try {
    await ops.drop(row.db_name, row.db_user);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `Veritabanı düşürülemedi: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
  await pg.query("DELETE FROM panel_databases WHERE id = $1", [row.id]);
}

/**
 * Domain silinmeden ÖNCE çağrılır: o domaine ait gerçek veritabanlarını
 * düşürür. Yalnızca ON DELETE CASCADE'e güvenilseydi panel satırı gider,
 * gerçek veritabanı sunucuda öksüz kalırdı.
 *
 * @returns Düşürülemeyen veritabanlarının açıklamaları (boşsa hepsi temiz).
 */
export async function dropDatabasesForDomain(pg: Pool, domainId: number): Promise<string[]> {
  const { rows } = await pg.query<PanelDatabaseRow>(
    "SELECT id, domain_id, engine, db_name, db_user, created_at FROM panel_databases WHERE domain_id = $1",
    [domainId],
  );

  const failures: string[] = [];
  for (const row of rows) {
    try {
      await dropDatabase(pg, row);
    } catch (err) {
      failures.push(
        `${row.engine}/${row.db_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return failures;
}
