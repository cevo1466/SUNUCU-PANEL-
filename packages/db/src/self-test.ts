import { Client } from "pg";
import { startPostgres, stopPostgres } from "./instance.js";
import { DATABASE_URL } from "./config.js";

// Gerçek musl-native PostgreSQL 16'yı başlatıp gerçek bir migration + CRUD ile
// doğrular. Mock yok — DEFINITION_OF_DONE.md gereği "muhtemelen çalışır" kabul edilmez.

async function main() {
  const { startedByUs } = await startPostgres();

  try {
    const { runner } = await import("node-pg-migrate");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    await runner({
      databaseUrl: DATABASE_URL,
      dir: path.resolve(here, "..", "migrations"),
      direction: "up",
      migrationsTable: "pgmigrations",
      count: Infinity,
    });

    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();

    await client.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      ["selftest", "selftest@example.invalid", "x"],
    );
    const { rows } = await client.query(
      "SELECT id, username FROM users WHERE username = $1",
      ["selftest"],
    );
    if (rows.length !== 1) {
      throw new Error("self-test: users tablosuna yazılan satır okunamadı");
    }
    await client.query("DELETE FROM users WHERE username = $1", ["selftest"]);
    await client.end();
    console.log("✓ packages/db self-test geçti (gerçek PostgreSQL + migration + CRUD)");
  } finally {
    if (startedByUs) await stopPostgres();
  }
}

main().catch((err) => {
  console.error("✗ packages/db self-test BAŞARISIZ:", err);
  process.exit(1);
});
