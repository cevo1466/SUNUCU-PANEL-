import fs from "node:fs";

// PostgreSQL 16 is installed in the image. A fresh server must not rely on
// downloading exact historical APK revisions during its first boot.
export const RUNTIME_DIR = "/usr";
export const PG_BIN_DIR = "/usr/libexec/postgresql16";
export const PG_LIB_PATHS = ["/usr/lib", "/usr/lib/postgresql16"];

export function pgDumpPath(): string { return "/usr/bin/pg_dump"; }
export function psqlPath(): string { return "/usr/bin/psql"; }
export function pgLdLibraryPath(): string {
  return ["/usr/lib", ...(process.env.LD_LIBRARY_PATH ? [process.env.LD_LIBRARY_PATH] : [])].join(":");
}
export function isRuntimeInstalled(): boolean {
  return fs.existsSync(`${PG_BIN_DIR}/postgres`) && fs.existsSync(pgDumpPath());
}
export async function ensureRuntimeInstalled(): Promise<void> {
  if (!isRuntimeInstalled()) throw new Error("PostgreSQL 16 Docker imajında kurulu değil.");
}
