import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../env.js";
import { getBackupSchedule } from "./backup-schedule.js";

const execFileAsync = promisify(execFile);

/**
 * "Sunucu sagligi" sayfasinin verisi.
 *
 * NEDEN VAR: panel 11 servis calistiriyor ama hicbirinin durumu arayuzde
 * gorunmuyordu — yalnizca kabuktan `service.sh status` ile. Sunucudaki
 * sertifikalarin cogu da gorunmuyordu (`/ssl` yalnizca panel domainlerini
 * listeliyor; webmail ve panel sertifikalari hic yoktu) ve zamanlanmis
 * islerin calisip calismadigini gosteren hicbir yer yoktu. Bu oturumda
 * bulunan ciddi hatalarin cogu tam olarak bu korlukten cikti: php-fpm hic
 * kurulu degildi, opendkim tablolari okumuyordu, uc sertifika hic
 * yenilenmiyordu.
 */

export interface ServiceStatus {
  name: string;
  label: string;
  port: number;
  running: boolean;
  /** Ne ise yaradigi — operatorun "bu neydi" diye sormamasi icin. */
  role: string;
  /** Hangi adreste dinledigi. Cogu 127.0.0.1; php-fpm koprude. */
  host: string;
}

export interface CertificateStatus {
  name: string;
  domains: string[];
  expiresAt: string;
  daysLeft: number;
}

export interface ScheduledJob {
  label: string;
  schedule: string;
  command: string;
  /**
   * Log dosyasinin son degisme zamani.
   *
   * "SON CALISMA" DEGIL "SON CIKTI". Gozetmen isleri her dakika calisir ama
   * yalnizca GERCEKTEN mudahale ettiklerinde yazarlar (log sismesin diye).
   * watchdog.log 3 saat once yazilmis olabilir ve is hala dakikada bir
   * calisiyor olabilir — bu iki sey ayni degil ve "son calisma" demek
   * "gozetmen olmus" yanilgisi yaratirdi.
   */
  lastOutputAt: string | null;
  /** Bu is yalnizca mudahale ettiginde mi yazar? */
  quiet: boolean;
  logPath: string | null;
  /** Cron satırı kurulu olsa da kullanıcı otomatik yedeklemeyi kapatabilir. */
  enabled: boolean;
}

export interface ServerHealth {
  services: ServiceStatus[];
  certificates: CertificateStatus[];
  certificateError?: string;
  jobs: ScheduledJob[];
  jobsError?: string;
}

/**
 * Servis listesi. Port, o servisin GERCEKTEN dinledigi port.
 *
 * PID DOSYASINA BAKILMIYOR: bu projede tekrar eden hata sinifi tam olarak
 * "kayit X diyor, gercek Y" — ftp-ctl pidfile'a guvenip calisan servisi olu
 * saymisti, service.sh'in saglik dongusu de olu servisi saglikli
 * gostermisti. Tek durust olcum: porta baglanmayi denemek.
 */
const LOOPBACK = "127.0.0.1";
/**
 * php-fpm BILEREK loopback'te DEGIL, Docker koprusunde dinliyor: gercek nginx
 * ayri bir konteynerde ve oraya ancak koprü uzerinden ulasabiliyor. FastCGI'nin
 * kimlik dogrulamasi olmadigi icin 0.0.0.0 da kullanilmadi.
 *
 * Bu ayrimi atlamak SESSIZ BIR YALAN uretiyordu: ilk yazimda hepsi 127.0.0.1
 * ile sorulunca php-fpm "DURMUS" gorunuyordu, oysa calisiyordu. Kullaniciyi
 * olmayan bir arizanin pesine dusururdu.
 */
const BRIDGE = process.env.NGINX_UPSTREAM_HOST ?? "172.19.0.1";

const SERVICES: Array<Omit<ServiceStatus, "running">> = [
  { name: "web", label: "Panel arayüzü", port: 3000, host: LOOPBACK, role: "Next.js — panelin kendisi" },
  { name: "api", label: "Panel API", port: 3001, host: LOOPBACK, role: "Fastify — bütün panel işlemleri" },
  { name: "postgres", label: "PostgreSQL", port: 5433, host: LOOPBACK, role: "Panelin kendi veritabanı" },
  { name: "mariadb", label: "MariaDB", port: 3306, host: LOOPBACK, role: "Müşteri veritabanları" },
  { name: "php-fpm", label: "PHP-FPM", port: 9000, host: BRIDGE, role: "PHP çalıştıran siteler" },
  { name: "adminer", label: "Adminer", port: 8098, host: LOOPBACK, role: "Veritabanı yönetim arayüzü" },
  { name: "postfix", label: "Postfix (SMTP)", port: 25, host: LOOPBACK, role: "Gelen posta" },
  { name: "submission", label: "Postfix (gönderim)", port: 587, host: LOOPBACK, role: "Giden posta — kimlik doğrulamalı" },
  { name: "dovecot", label: "Dovecot (IMAPS)", port: 993, host: LOOPBACK, role: "Posta kutularına erişim" },
  { name: "opendkim", label: "OpenDKIM", port: 8891, host: LOOPBACK, role: "Giden postayı imzalar" },
  { name: "pure-ftpd", label: "FTP", port: 21, host: LOOPBACK, role: "Dosya aktarımı" },
  { name: "named", label: "BIND9 (DNS)", port: 53, host: LOOPBACK, role: "Sunucunun kendi DNS'i" },
];

/**
 * Port GERCEKTEN baglanti kabul ediyor mu.
 *
 * Kisa zaman asimi bilincli: bu sayfa 12 servis sorgular ve hepsi ayni anda
 * calisir; takilan bir port sayfayi bekletmemeli. Zaman asimi "calismiyor"
 * sayilir — cunku kullanicinin gordugu de tam olarak budur.
 */
function portAccepting(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** Zamanlanmis isin insan tarafindan okunur adi ve ciktisinin gittigi log. */
function describeJob(command: string): { label: string; logPath: string | null } {
  const logMatch = />>\s*(\S+\.log)/.exec(command);
  const logPath = logMatch ? logMatch[1] : null;
  if (command.includes("ssl-renew.sh")) return { label: "SSL yenileme", logPath };
  if (command.includes("backup-scheduled.sh verify")) return { label: "Yedek doğrulama", logPath };
  if (command.includes("backup-scheduled.sh run")) return { label: "Yedek alma", logPath };
  if (command.includes("backup-verify.sh")) return { label: "Yedek doğrulama", logPath };
  if (command.includes("backup-run.sh")) return { label: "Yedek alma", logPath };
  if (command.includes("mail-ctl.sh")) return { label: "Posta gözetmeni", logPath };
  if (command.includes("ftp-ctl.sh")) return { label: "FTP gözetmeni", logPath };
  if (command.includes("dns-ctl.sh")) return { label: "DNS gözetmeni", logPath };
  if (command.includes("service.sh")) return { label: "Servis gözetmeni", logPath };
  return { label: command.split("/").pop() ?? command, logPath };
}

async function lastRunOf(logPath: string | null): Promise<string | null> {
  if (!logPath) return null;
  try {
    const stat = await fs.stat(logPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

export async function readServerHealth(): Promise<ServerHealth> {
  const services: ServiceStatus[] = await Promise.all(
    SERVICES.map(async (service) => ({
      ...service,
      running: await portAccepting(service.host, service.port),
    })),
  );

  const certificates: CertificateStatus[] = [];
  const jobs: ScheduledJob[] = [];
  let certificateError: string | undefined;
  let jobsError: string | undefined;
  const backupSchedule = await getBackupSchedule();

  try {
    const script = path.join(PROJECT_ROOT, "ops", "scripts", "server-status.sh");
    const { stdout } = await execFileAsync("sudo", ["-n", script], {
      timeout: 20_000,
      maxBuffer: 1024 * 256,
    });
    const now = Date.now();
    for (const line of stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts[0] === "CERT" && parts.length >= 4) {
        const expiresAt = new Date(parts[3]);
        if (Number.isNaN(expiresAt.getTime())) continue;
        certificates.push({
          name: parts[1],
          domains: parts[2] ? parts[2].split(",").filter(Boolean) : [],
          expiresAt: expiresAt.toISOString(),
          daysLeft: Math.floor((expiresAt.getTime() - now) / 86_400_000),
        });
      } else if (parts[0] === "CRON" && parts.length >= 3) {
        const { label, logPath } = describeJob(parts[2]);
        jobs.push({
          label,
          schedule: parts[1],
          command: parts[2],
          logPath,
          lastOutputAt: await lastRunOf(logPath),
          quiet: parts[2].includes("ensure"),
          enabled: parts[2].includes("backup-scheduled.sh") ? backupSchedule.enabled : true,
        });
      }
    }
  } catch (err) {
    // SESSIZ GECILMEZ. Okunamayan bir sertifika listesini "sertifika yok"
    // diye gostermek, tam olarak bu panelde tekrar eden hata: kaydin
    // yoklugunu gercegin yoklugu sanmak.
    const message =
      (err as { stderr?: string }).stderr?.trim() || (err as Error).message || "okunamadı";
    certificateError = message;
    jobsError = message;
  }

  certificates.sort((a, b) => a.daysLeft - b.daysLeft);
  return { services, certificates, certificateError, jobs, jobsError };
}
