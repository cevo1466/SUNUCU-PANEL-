import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { startPostgres, stopPostgres } from "./instance.js";
import { DATABASE_URL, DB_NAME, PGDATA_DIR } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "migrations");

export { DATABASE_URL, PGDATA_DIR, DB_NAME, startPostgres, stopPostgres };

export async function startEmbeddedDb() {
  const { startedByUs } = await startPostgres();
  // Zaten çalışan bir sunucuyu ödünç aldıysak durdurmuyoruz — o sunucu canlı
  // panele hizmet ediyor olabilir.
  return { stop: startedByUs ? stopPostgres : async () => {} };
}

export async function runMigrations() {
  await runner({
    databaseUrl: DATABASE_URL,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Infinity,
  });
}
