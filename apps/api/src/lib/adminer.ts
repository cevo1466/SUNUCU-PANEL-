import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GENERATED_DIR } from "./domain.js";

const execFileAsync = promisify(execFile);

const SETTINGS_PATH = path.join(GENERATED_DIR, "adminer-settings.json");
const ADMINER_PHP_FILE = path.resolve(GENERATED_DIR, "..", "adminer", "adminer.php");
// Servisler SCREEN ICINDE CALISTIRILMAZ (kullanicinin kesin kurali, 2026-08-27):
// screen oturumu kapaninca servisler oluyor ve panel 502 veriyordu. Tek giris
// noktasi service.sh; her servisi `setsid` ile kendi oturumunda baslatir ve
// crond watchdog'u dusenleri kaldirir (bkz. ops/scripts/service.sh basligi).
const SERVICE_SCRIPT = path.resolve(GENERATED_DIR, "..", "scripts", "service.sh");

/**
 * Adminer, php-fpm değil PHP'nin kendi CLI geliştirme sunucusuyla
 * (`php -S`) çalışır (bkz. supervise.sh "adminer" case'i) — bu yüzden
 * discoverPhpVersions() (php-fpm soket dizinlerini tarar) burada işe
 * yaramaz. Doğrudan PATH üzerindeki çalıştırılabilir `php*` binary'leri
 * taranır.
 *
 * GERÇEK YORUMLAYICIYA GÖRE TEKİLLEŞTİRİLİR. Alpine'da tek bir PHP kurulumu
 * üç ad birden bırakıyor: `php`, `php8.4` ve `php84` — üçü de sembolik link
 * olarak aynı `/usr/bin/php84` dosyasına çıkıyor. Ham liste kullanıcıya
 * "seçebileceğiniz üç PHP sürümü var" gibi görünüyordu; oysa tek bir sürüm
 * var ve hangisini seçerse seçsin aynı şey çalışıyordu. Artık her gerçek
 * dosya için TEK giriş gösteriliyor.
 */
export async function discoverPhpCliBinaries(): Promise<string[]> {
  const dirs = ["/usr/bin", "/usr/local/bin", "/usr/sbin"];
  // gerçek dosya yolu -> o dosyaya işaret eden adlar
  const byRealPath = new Map<string, string[]>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // Alpine paketleri "php84" (noktasız) verir, bazı sistemler "php8.4"
      // sembolik linki kurar — ikisi de kabul edilir.
      if (!/^php(\d{1,3}|\d\.\d+)?$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        await fs.access(full, fsSync.constants.X_OK);
      } catch {
        continue; // çalıştırılamıyorsa listelenmez
      }
      // Sembolik linkleri çöz: aynı dosyaya çıkan adlar tek gruba düşer.
      let real: string;
      try {
        real = await fs.realpath(full);
      } catch {
        real = full;
      }
      const names = byRealPath.get(real) ?? [];
      if (!names.includes(name)) names.push(name);
      byRealPath.set(real, names);
    }
  }

  // Her gruptan TEK ad seçilir. Tercih: gerçek dosyanın kendi adı (Alpine'da
  // "php84"); yoksa en uzun ad, çünkü "php8.4" jenerik "php"den daha çok bilgi
  // taşır ve sürüm yükseltmesinde hangi sürümün seçildiği belirsiz kalmaz.
  const chosen: string[] = [];
  for (const [real, names] of byRealPath) {
    const realName = path.basename(real);
    chosen.push(
      names.includes(realName)
        ? realName
        : [...names].sort((a, b) => b.length - a.length || a.localeCompare(b))[0],
    );
  }
  return chosen.sort();
}

export interface AdminerSettings {
  php_bin: string | null;
}

async function readSettings(): Promise<AdminerSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AdminerSettings>;
    return { php_bin: parsed.php_bin ?? null };
  } catch {
    return { php_bin: null };
  }
}

async function writeSettings(settings: AdminerSettings): Promise<void> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

export function isAdminerInstalled(): boolean {
  return fsSync.existsSync(ADMINER_PHP_FILE);
}

export interface AdminerStatus {
  installed: boolean;
  availablePhpBinaries: string[];
  selectedPhpBin: string | null;
  /** Adminer'in baglanabilmesi icin gereken PHP eklentileri. */
  drivers: { postgres: boolean; mysql: boolean };
  /** Eksik bir sey varsa operatore ne yapacagini soyleyen dumduz not. */
  note: string | null;
}

/**
 * Adminer'in SECILI PHP binary'sinde veritabani surucusu yuklu mu?
 *
 * NEDEN VAR (gercek arizanin kok nedeni, 2026-08-28): Adminer ayakta,
 * giris formu aciliyor ve butun motorlari listeliyordu — ama PHP'de
 * `pgsql`/`mysqli` eklentilerinin HICBIRI kurulu degildi. Kullanici formu
 * dolduruyor, "Giris" diyor ve HER SEFERINDE basarisiz oluyordu; panel de
 * "Adminer kurulu" diyerek yanlis bir guven veriyordu. Dosyanin varligina
 * bakmak yetmez, baglanabildigini de bilmek gerekir.
 */
async function detectPhpDrivers(phpBin: string): Promise<{ postgres: boolean; mysql: boolean }> {
  const check = async (ext: string): Promise<boolean> => {
    try {
      const { stdout } = await execFileAsync(phpBin, [
        "-r",
        `echo extension_loaded(${JSON.stringify(ext)}) ? "1" : "0";`,
      ]);
      return stdout.trim() === "1";
    } catch {
      return false;
    }
  };
  const [postgres, mysql] = await Promise.all([check("pgsql"), check("mysqli")]);
  return { postgres, mysql };
}

export async function getAdminerStatus(): Promise<AdminerStatus> {
  const [settings, binaries] = await Promise.all([readSettings(), discoverPhpCliBinaries()]);
  const installed = isAdminerInstalled();
  const phpBin = settings.php_bin ?? binaries[0] ?? "php";
  const drivers = installed
    ? await detectPhpDrivers(phpBin)
    : { postgres: false, mysql: false };

  let note: string | null = null;
  if (!installed) {
    note = "Adminer kurulu değil. ops/scripts/install-adminer.sh ile indirin.";
  } else if (!drivers.postgres && !drivers.mysql) {
    note =
      `Adminer kurulu ama ${phpBin} sürümünde hiçbir veritabanı sürücüsü yok — ` +
      "giriş denemesi her zaman başarısız olur. Kurulum root ister: " +
      `apk add ${phpBin}-pgsql ${phpBin}-pdo_pgsql ${phpBin}-mysqli ${phpBin}-pdo_mysql`;
  } else if (!drivers.postgres) {
    note = `PostgreSQL sürücüsü yok (apk add ${phpBin}-pgsql). PostgreSQL girişleri başarısız olur.`;
  } else if (!drivers.mysql) {
    note = `MySQL sürücüsü yok (apk add ${phpBin}-mysqli). MySQL girişleri başarısız olur.`;
  }

  return {
    installed,
    availablePhpBinaries: binaries,
    selectedPhpBin: settings.php_bin,
    drivers,
    note,
  };
}

export class AdminerError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Seçilen PHP binary'sini kaydeder ve Adminer servisini yeniden başlatır.
 * Adminer devuser altında (root gerekmeden) çalıştığı için burada sudo
 * YOKTUR — deploy-vhost.sh'in aksine bu işlem ayrıcalıklı değildir
 * (bkz. PROD-DEPLOYMENT.md §2b).
 *
 * Seçilen sürüm supervise.sh'e ADMINER_PHP_BIN ile değil, kaydedilen
 * ayar dosyası üzerinden geçer: service.sh yeni bir süreç başlatır ve
 * supervise.sh ayarı ops/generated/adminer-settings.json'dan okur.
 */
export async function setAdminerPhpBin(phpBin: string): Promise<AdminerSettings> {
  const available = await discoverPhpCliBinaries();
  if (!available.includes(phpBin)) {
    throw new AdminerError(
      `"${phpBin}" sunucuda bulunamadı. Kurulu sürümler: ${available.join(", ") || "(yok)"}.`,
      400,
    );
  }
  const settings: AdminerSettings = { php_bin: phpBin };
  await writeSettings(settings);

  try {
    await execFileAsync(SERVICE_SCRIPT, ["restart", "adminer"], {
      env: { ...process.env, ADMINER_PHP_BIN: phpBin },
    });
  } catch (err) {
    throw new AdminerError(
      `PHP sürümü kaydedildi ama Adminer yeniden başlatılamadı: ${(err as Error).message}`,
      500,
    );
  }

  return settings;
}
