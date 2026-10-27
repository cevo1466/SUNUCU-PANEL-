import { stopPostgres } from "./instance.js";

stopPostgres()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ PostgreSQL durdurulamadı:", err);
    process.exit(1);
  });
