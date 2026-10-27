import fs from "node:fs/promises";
import path from "node:path";
import { GENERATED_DIR } from "./domain.js";

const FLAG = path.join(GENERATED_DIR, "automatic-backups.enabled");

export interface BackupSchedule {
  enabled: boolean;
  backup_utc: string;
  verify_utc: string;
}

export async function getBackupSchedule(): Promise<BackupSchedule> {
  let enabled = false;
  try {
    await fs.access(FLAG);
    enabled = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { enabled, backup_utc: "daily 02:40", verify_utc: "Sunday 04:20" };
}

export async function setBackupSchedule(enabled: boolean): Promise<BackupSchedule> {
  if (enabled) {
    await fs.mkdir(GENERATED_DIR, { recursive: true });
    await fs.writeFile(FLAG, "enabled\n", { mode: 0o600 });
  } else {
    try {
      await fs.unlink(FLAG);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return getBackupSchedule();
}
