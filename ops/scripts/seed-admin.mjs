#!/usr/bin/env node
import { Client } from "pg";
import { hash } from "@node-rs/argon2";

const [email, username] = process.argv.slice(2);
if (!email || !username || !process.env.DATABASE_URL) {
  console.error("Kullanım: seed-admin.mjs <email> <username> (parola stdin)");
  process.exit(2);
}

let password = "";
for await (const chunk of process.stdin) password += chunk.toString();
password = password.replace(/\r?\n$/, "");
if (password.length === 0) {
  console.error("Yönetici parolası boş olamaz.");
  process.exit(2);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query("SELECT id FROM users WHERE email = $1", [email]);
  if (rows.length) {
    console.log("Yönetici hesabı zaten var; parola değiştirilmedi.");
  } else {
    const hashed = await hash(password);
    await client.query(
      "INSERT INTO users (username, email, password_hash, role) VALUES ($1,$2,$3,'admin')",
      [username, email, hashed],
    );
    console.log("Yönetici hesabı oluşturuldu.");
  }
} finally {
  password = "";
  await client.end();
}
