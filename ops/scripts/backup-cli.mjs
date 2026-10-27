#!/usr/bin/env node
/**
 * ops/scripts/backup-cli.mjs <snapshot|verify> <domain>
 *
 * Zamanlanmis islerin (backup-run.sh, backup-verify.sh) TypeScript yedekleme
 * kodunu cagirmasi icin ince bir kabuk.
 *
 * NEDEN HTTP UCU DEGIL: cron'un panel oturumu yoktur ve yedekleme dakikalar
 * surebilir — bunu bir HTTP istegine baglamak zaman asimina davetiye olurdu.
 * NEDEN AYRI DOSYA: kabuk script'leri tsx cagirmasin diye; derlenmis
 * apps/api/dist kullanilir (canlida zaten derli).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const require_ = createRequire(import.meta.url);
require_("dotenv").config({ path: path.join(projectRoot, ".env.loopkit") });

const [action, domain] = process.argv.slice(2);
if (!action || !domain) {
  console.error("Kullanim: backup-cli.mjs <snapshot|verify> <domain>");
  process.exit(2);
}

const distDir = path.join(projectRoot, "apps", "api", "dist");
const { Client } = require_(path.join(projectRoot, "node_modules", "pg"));

// DATABASE_URL'i env.js kendi okur (.env.loopkit), cron ortaminda da calisir.
const { env } = await import(path.join(distDir, "env.js"));

const client = new Client(env.DATABASE_URL);
await client.connect();

try {
  if (action === "snapshot") {
    const { createDomainSnapshot } = await import(path.join(distDir, "lib", "backup-snapshot.js"));
    const { rotateBackups } = await import(path.join(distDir, "lib", "backup-storage.js"));

    const { rows } = await client.query(
      `INSERT INTO backup_runs (domain_name, kind, archive_name, status)
       VALUES ($1,'domain','(devam ediyor)','running') RETURNING id`,
      [domain],
    );
    const runId = rows[0].id;
    try {
      const { stored, manifest } = await createDomainSnapshot(client, domain);
      await client.query(
        `UPDATE backup_runs SET archive_name=$1, size_bytes=$2, manifest=$3, status='ok', finished_at=NOW() WHERE id=$4`,
        [stored.name, stored.sizeBytes, JSON.stringify(manifest), runId],
      );

      // Rotasyon — dogrulanmis yedek korunur.
      const verified = await client.query(
        `SELECT archive_name FROM backup_runs WHERE domain_name=$1 AND verify_status='ok'`,
        [domain],
      );
      const removed = await rotateBackups(
        domain,
        env.BACKUP_KEEP,
        new Set(verified.rows.map((r) => r.archive_name)),
      );

      console.log(
        `  ${stored.name} · ${(stored.sizeBytes / 1024 / 1024).toFixed(1)} MB · ` +
          `${manifest.file_count} dosya · ${manifest.databases.length} veritabani` +
          (manifest.complete ? "" : ` · EKSIK: ${manifest.warnings.join("; ")}`) +
          (removed.length ? ` · rotasyon: ${removed.length} eski surum silindi` : ""),
      );
      // Eksik yedek BASARILI SAYILMAZ: cagiran script bildirim gonderir.
      if (!manifest.complete) process.exitCode = 1;
    } catch (err) {
      await client.query(
        `UPDATE backup_runs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2`,
        [err.message, runId],
      );
      throw err;
    }
  } else if (action === "verify") {
    const { verifyLatestBackup } = await import(path.join(distDir, "lib", "backup-verify.js"));
    const outcome = await verifyLatestBackup(client, domain);
    if (!outcome) {
      console.log("  yedek yok, dogrulanacak bir sey bulunamadi");
    } else if (outcome.result.ok) {
      const d = outcome.result.detail;
      console.log(
        `  ${outcome.archive} · ${d.parts_checked} parca saglam · ` +
          `${d.file_count_actual}/${d.file_count_expected} dosya · ` +
          `${d.databases_loaded.length} veritabani gercekten yuklendi`,
      );
    } else {
      console.error(`  ${outcome.archive}: ${outcome.result.error}`);
      process.exitCode = 1;
    }
  } else {
    console.error(`Bilinmeyen eylem: ${action}`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`  HATA: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
