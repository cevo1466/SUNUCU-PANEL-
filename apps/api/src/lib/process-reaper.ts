import fs from "node:fs/promises";
import path from "node:path";

/**
 * Bir yolu diskten silmek, o yoldan CALISAN sureci durdurmaz.
 *
 * GERCEKTE YASANDI (2026-09-07, kullanici bildirdi): testsite.ornek.test
 * altindaki uygulama klasoru dosya yoneticisinden "tumunu sec + sil" ile
 * silindi. Dizin gercekten bosaldi, ama site tarayicida acilmaya devam etti.
 * Sebep tek bir cache degil, iki katman ust uste:
 *
 *  1. nginx o vhost'ta `root` yerine `proxy_pass http://172.19.0.1:3200`
 *     kullaniyordu — dizinin bos olmasi yaniti hic etkilemiyordu.
 *  2. 3200 portundaki `next-server` sureci hala ayaktaydi. Linux'ta silinen
 *     bir inode'u ACIK TUTAN surec varken dosya diskten gercekten kaybolmaz
 *     (`/proc/<pid>/cwd -> ... (deleted)`), sunucu da sayfalari kendi bellek
 *     ici cache'inden basmaya devam eder.
 *
 * Toplam 11 hayalet surec bulundu (next-server, iki crawler worker'i, alti
 * headless chromium, bir `serve`). Hicbiri dosya yoneticisinden gorunmuyordu.
 *
 * Bu modul silme AKISININ PARCASI olarak calisir: silinecek yolu tutan
 * surecler once durdurulur, sonra `fs.rm` calisir. Sirasi onemli — once
 * silip sonra oldurmek, arada dogan hayalet surecin silinmis inode'u
 * canli tutmasina izin verirdi.
 */

export interface ReapedProcess {
  pid: number;
  cmd: string;
  /** Sureci hedefe baglayan kanit: calisma dizini, calistirilabilir dosya veya acik tanitici. */
  reason: "cwd" | "exe" | "fd";
  outcome: "terminated" | "killed" | "failed";
}

/** `/proc/<pid>/cwd` silinmis dizinleri " (deleted)" ekiyle bildirir. */
const DELETED_SUFFIX = " (deleted)";

function stripDeleted(link: string): string {
  return link.endsWith(DELETED_SUFFIX) ? link.slice(0, -DELETED_SUFFIX.length) : link;
}

/**
 * `candidate`, `root`'un kendisi mi yoksa altinda mi?
 *
 * Ayirici olmadan `startsWith` "/a/site" ile "/a/site-yedek"i esitlerdi;
 * yedek klasorden calisan bir surec yanlislikla oldurulurdu.
 */
function isAtOrUnder(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

async function readLinkOrNull(linkPath: string): Promise<string | null> {
  try {
    return await fs.readlink(linkPath);
  } catch {
    // ESRCH (surec bitti), EACCES (baska kullanicinin sureci), ENOENT — hepsi
    // "bu surec hakkinda bir sey soyleyemeyiz" demek, taramayi durdurmaz.
    return null;
  }
}

async function readCmdline(pid: number): Promise<string> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    const cmd = raw.replace(/\0/g, " ").trim();
    if (cmd) return cmd.slice(0, 200);
  } catch {
    /* asagidaki comm'e dus */
  }
  try {
    return (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    return `pid ${pid}`;
  }
}

/**
 * Hedef yolu tutan surecleri bulur.
 *
 * Uc kanit da taranir: `cwd` (yukaridaki 11 hayaletin hepsi buradan yakalandi),
 * `exe` (klasordeki bir ikiliyi calistiran surec — cwd'si baska yerde olabilir)
 * ve acik dosya taniticilari (silinen dosyayi acik tutup disk yerini birakmayan
 * surec). Yalnizca cwd'ye bakmak, `fd` uzerinden tutulan dosyalari kacirirdi.
 */
async function findHoldingProcesses(
  target: string,
): Promise<Array<{ pid: number; reason: ReapedProcess["reason"] }>> {
  let pidDirs: string[];
  try {
    pidDirs = await fs.readdir("/proc");
  } catch {
    // /proc yok (Linux disi). Reaper sessizce devre disi kalir; silme islemi
    // yine de normal sekilde yurur.
    return [];
  }

  const self = process.pid;
  const found: Array<{ pid: number; reason: ReapedProcess["reason"] }> = [];

  for (const entry of pidDirs) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // Panel API'sinin kendini oldurmesi, silme istegini yanitlayamadan
    // olmesi demekti; kullanici "sunucu koptu" gorurdu.
    if (pid === self || pid === process.ppid) continue;

    const cwd = await readLinkOrNull(`/proc/${pid}/cwd`);
    if (cwd && isAtOrUnder(stripDeleted(cwd), target)) {
      found.push({ pid, reason: "cwd" });
      continue;
    }

    const exe = await readLinkOrNull(`/proc/${pid}/exe`);
    if (exe && isAtOrUnder(stripDeleted(exe), target)) {
      found.push({ pid, reason: "exe" });
      continue;
    }

    let fds: string[];
    try {
      fds = await fs.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      const link = await readLinkOrNull(`/proc/${pid}/fd/${fd}`);
      if (link && isAtOrUnder(stripDeleted(link), target)) {
        found.push({ pid, reason: "fd" });
        break;
      }
    }
  }

  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: surec yasiyor ama bizim degil — oldurulemez, "yasiyor" saymaliyiz
    // yoksa temizlendi sanip hayaleti ayakta birakirdik.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `target` yolunu tutan tum surecleri durdurur.
 *
 * Once SIGTERM (Next.js/serve gibi sunucular acik baglantiyi duzgun kapatsin),
 * kisa bir bekleyisin ardindan hala ayakta olanlara SIGKILL. Cikan listede
 * `outcome: "failed"` olan bir kayit varsa yol HALA tutuluyor demektir; cagiran
 * taraf bunu sessizce gecmemelidir.
 */
export async function reapProcessesUnder(target: string): Promise<ReapedProcess[]> {
  const holders = await findHoldingProcesses(target);
  if (holders.length === 0) return [];

  const reaped: ReapedProcess[] = [];
  for (const { pid, reason } of holders) {
    reaped.push({ pid, cmd: await readCmdline(pid), reason, outcome: "terminated" });
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* zaten olmus ya da bizim degil — asagidaki canlilik kontrolu karar verir */
    }
  }

  // 2 sn: Next.js'in kapanmasina yetiyor, panel istegini bekletmeyecek kadar kisa.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && reaped.some((r) => isAlive(r.pid))) {
    await sleep(100);
  }

  for (const record of reaped) {
    if (!isAlive(record.pid)) continue;
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      /* asagida dogrulanir */
    }
    await sleep(100);
    record.outcome = isAlive(record.pid) ? "failed" : "killed";
  }

  return reaped;
}

/** Kullaniciya gosterilecek tek satirlik ozet. */
export function describeReaped(reaped: ReapedProcess[]): string {
  return reaped.map((r) => `${r.cmd} (pid ${r.pid})`).join(", ");
}
