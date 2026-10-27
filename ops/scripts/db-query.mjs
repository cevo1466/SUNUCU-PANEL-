#!/usr/bin/env node
/**
 * ops/scripts/db-query.mjs "<SQL>" [param...]
 *
 * Kabuk script'lerinin panel veritabanini sorgulamasi icin kucuk yardimci.
 *
 * NEDEN VAR (gercek kusur, 2026-09-01): `ssl-renew.sh` sorgularini `psql` ile
 * yapiyordu ama BU SUNUCUDA psql YOK — panelin PostgreSQL'i
 * `packages/db/.pg-runtime` altinda gomulu calisiyor ve o paket yalnizca
 * sunucu ikililerini iceriyor, istemci araclarini degil. Script her
 * calistiginda "psql bulunamadi" ile duruyordu. Cron'a eklenmis olsaydi bile
 * her gece sessizce hata verecekti.
 *
 * IKINCI KUSUR: script `DATABASE_URL`'i ORTAMDAN bekliyordu. Cron ortaminda
 * kabuk profili yuklenmez, yani o degisken hicbir zaman tanimli olmazdi ve
 * script daha ilk kontrolde duserdi. Bu yardimci `.env.loopkit`'i kendisi
 * okur; cagiran script'in ortam kurmasi gerekmez.
 *
 * Cikti: her satir bir kayit, alanlar TAB ile ayrilir. Deger yoksa bos string.
 * Parametreler $1, $2... olarak baglanir (string birlestirme YAPILMAZ —
 * SQL enjeksiyonuna kapali).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(path.join(projectRoot, ".env.loopkit"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* dosya yok: asagidaki varsayilana dus */
  }
  // apps/api/src/env.ts ile AYNI varsayilan.
  return "postgres://studio:studio@127.0.0.1:5433/studio_panel";
}

const [sql, ...params] = process.argv.slice(2);
if (!sql) {
  console.error('Kullanim: db-query.mjs "<SQL>" [param...]');
  process.exit(2);
}

const client = new pg.Client(databaseUrl());
try {
  await client.connect();
  const result = await client.query(sql, params);
  for (const row of result.rows) {
    process.stdout.write(Object.values(row).map((v) => (v === null ? "" : String(v))).join("\t") + "\n");
  }
} catch (err) {
  console.error(`db-query: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
