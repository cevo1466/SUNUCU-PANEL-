import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, "..");
export const PGDATA_DIR = path.join(PACKAGE_ROOT, ".pgdata");

export const DB_PORT = Number(process.env.STUDIO_PG_PORT ?? 5433);
export const DB_USER = process.env.STUDIO_PG_USER ?? "studio";
export const DB_PASSWORD = process.env.STUDIO_PG_PASSWORD ?? "studio";
export const DB_NAME = process.env.STUDIO_PG_DATABASE ?? "studio_panel";

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}`;
