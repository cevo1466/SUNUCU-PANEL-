import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Domain oluşturulduğunda otomatik Claude-mem hafıza dizini oluşturur.
 * Yapı: /home/{user}/.claude/projects/{domain_name}/memory/
 */
export async function initializeClaudeMemory(domainName: string): Promise<{ path: string; created: boolean }> {
  try {
    const homeDir = os.homedir();
    const memoryPath = path.join(homeDir, ".claude", "projects", domainName, "memory");

    // Dizin zaten varsa, sadece rapor et (idempotent)
    try {
      await fs.access(memoryPath);
      return { path: memoryPath, created: false };
    } catch {
      // Dizin yok, oluştur
    }

    // Rekursif oluştur
    await fs.mkdir(memoryPath, { recursive: true, mode: 0o755 });

    // MEMORY.md dosyasını oluştur (boş index)
    const memoryIndexPath = path.join(memoryPath, "MEMORY.md");
    await fs.writeFile(
      memoryIndexPath,
      `# ${domainName} - Claude Code Memories\n\nBu domain için kaydedilen hafızalar burada görünür.\n`,
      "utf8",
    );

    return { path: memoryPath, created: true };
  } catch (err) {
    // Hata durumunda domain oluşturmayı engellemeyen bir uyarı logla
    console.error(`[Claude-mem] ${domainName} için hafıza dizini oluşturulamadı:`, err);
    return { path: "", created: false };
  }
}
