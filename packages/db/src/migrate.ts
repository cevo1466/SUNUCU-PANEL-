import { runner } from "node-pg-migrate";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_URL } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "migrations");

const direction = (process.argv[2] === "down" ? "down" : "up") as "up" | "down";

async function main() {
  await runner({
    databaseUrl: DATABASE_URL,
    dir: migrationsDir,
    direction,
    migrationsTable: "pgmigrations",
    count: direction === "down" ? 1 : Infinity,
    verbose: true,
  });
  console.log(`✓ Migration '${direction}' tamamlandı`);
}

main().catch((err) => {
  console.error("✗ Migration başarısız:", err);
  process.exit(1);
});
