import fsSync from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../env.js";

/**
 * PostgreSQL istemci araclarinin (pg_dump, psql) yolu.
 *
 * NEDEN `@studio-panel/db`'DEN IMPORT EDILMIYOR: o paketin package.json'unda
 * `main` DOGRUDAN TypeScript kaynagini gosteriyor (`./src/index.ts`) ve
 * paketin derleme adimi yok. apps/api ise canlida DERLENMIS JavaScript olarak
 * calisiyor (`node dist/server.js`); oradan `@studio-panel/db` import etmek
 * calisma zamaninda
 *   "Cannot find module .../packages/db/src/instance.js"
 * ile duser. Ilk surumde tam olarak bu yasandi ve yalnizca API yeniden
 * baslatildiginda ortaya cikacakti — derleme sessizce gecmisti.
 *
 * Bu yuzden yol burada YENIDEN hesaplaniyor. Tek gercek kaynak olmamasi bir
 * bedel; karsiliginda apps/api'nin derlenmis hali bagimsiz kaliyor. Paket
 * surumu degisirse buradaki dizin adi da guncellenmeli
 * (packages/db/src/runtime.ts PACKAGES listesi).
 *
 * Bu sunucuda sistem genelinde pg_dump/psql YOKTUR — panelin PostgreSQL'i
 * yalnizca packages/db/.pg-runtime altinda. Sistem PATH'ine guvenilemez.
 */
const RUNTIME_DIR = path.join(PROJECT_ROOT, "packages", "db", ".pg-runtime");

function findBinary(name: string): string {
  // Alpine sunucu paketi /usr/libexec/postgresql16 altina, istemci paketi
  // /usr/bin altina koyuyor; ikisine de bakilir.
  const candidates = [
    path.join(RUNTIME_DIR, "usr", "libexec", "postgresql16", name),
    path.join(RUNTIME_DIR, "usr", "bin", name),
  ];
  return candidates.find((c) => fsSync.existsSync(c)) ?? candidates[0];
}

export function pgDumpBinary(): string {
  return findBinary("pg_dump");
}

export function psqlBinary(): string {
  return findBinary("psql");
}
