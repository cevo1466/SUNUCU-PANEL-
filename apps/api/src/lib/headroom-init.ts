import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Yeni domain için Headroom template'ini setup et
 * - repo'yu clone
 * - dependencies'i kur
 * - env setup
 */
export async function initializeHeadroom(
  domainName: string,
  domainPath: string,
): Promise<{ initialized: boolean; error?: string; details?: Record<string, unknown> }> {
  // Integration tests exercise domain provisioning without repeatedly cloning
  // an unrelated third-party repository. Normal panel requests still clone it.
  if (process.env.SKIP_OPTIONAL_HEADROOM === "1") return { initialized: false };
  try {
    // Headroom repo
    const HEADROOM_REPO = "https://github.com/headroomlabs-ai/headroom.git";
    const headroomDir = path.join(domainPath, "..", "headroom-clone");

    // 1. Repo'yu clone et (ilk kez)
    let repoCloned = false;
    try {
      await fs.access(headroomDir);
    } catch {
      // Dizin yok, clone et
      await execFileAsync("git", ["clone", "--depth", "1", HEADROOM_REPO, headroomDir], {
        timeout: 120_000, // 2 dakika
      });
      repoCloned = true;
    }

    // Headroom's repository can be Python-only. npm ci is valid only when a
    // Node lockfile exists; running it unconditionally made each new domain
    // log a failed install even though the source checkout succeeded.
    try {
      await fs.access(path.join(headroomDir, "package-lock.json"));
      await execFileAsync("npm", ["ci", "--no-audit", "--no-fund"], {
        cwd: headroomDir,
        timeout: 300_000,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[Headroom] ${domainName}: npm ci başarısız`, err);
      }
    }

    // 3. .env.local örneği oluştur (varsa)
    const envExamplePath = path.join(headroomDir, ".env.example");
    const envLocalPath = path.join(headroomDir, ".env.local");
    try {
      const envExample = await fs.readFile(envExamplePath, "utf-8");
      await fs.writeFile(
        envLocalPath,
        `# Domain: ${domainName}\n# Generated: ${new Date().toISOString()}\n\n${envExample}`,
        "utf-8",
      );
    } catch {
      // .env.example yoksa sorun değil
    }

    return {
      initialized: true,
      details: {
        headroom_path: headroomDir,
        repo_cloned: repoCloned,
        domain_name: domainName,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      initialized: false,
      error: errorMsg,
    };
  }
}
