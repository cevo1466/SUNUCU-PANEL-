import { startPostgres } from "./instance.js";

startPostgres()
  .then(() => {
    console.log("✓ PostgreSQL çalışıyor (arka planda, pg_ctl ile daemonize edildi)");
    process.exit(0);
  })
  .catch((err) => {
    console.error("✗ PostgreSQL başlatılamadı:", err);
    process.exit(1);
  });
