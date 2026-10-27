import {
  ArchiveBoxIcon,
  CircleStackIcon,
  CloudIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  FolderIcon,
  LockClosedIcon,
  ServerStackIcon,
  UserIcon,
  ArrowTopRightOnSquareIcon,
} from "@heroicons/react/24/outline";
import type { BackupVersion, Domain } from "@/lib/api";
import { formatBytes, formatDate, relativeDays } from "@/lib/format";
import type { ToolSection } from "./ToolGrid";

/**
 * Bir domainin araç kutucukları. Kutucuk notları gerçek veriden gelir; veri
 * henüz yüklenmediyse not yazılmaz (uydurma sayı gösterilmez).
 */
export function buildDomainTools({
  domain,
  dnsCount,
  databaseCount,
  mailCount,
  backup,
  onGenerateNginx,
  isAdmin,
}: {
  domain: Domain;
  dnsCount?: number;
  databaseCount?: number;
  mailCount?: number;
  backup?: BackupVersion | null;
  onGenerateNginx?: () => void;
  isAdmin?: boolean;
}): ToolSection[] {
  const base = `/domains/${domain.id}`;

  const sslNote = domain.ssl_status
    ? domain.ssl_expiry
      ? `Geçerli · ${relativeDays(domain.ssl_expiry) ?? formatDate(domain.ssl_expiry)} bitiyor`
      : "Geçerli"
    : "Sertifika yok";

  const nginxNote = domain.nginx_deployed
    ? "Nginx'te yayında"
    : domain.config_generated
      ? "Config üretildi, yayına alınmadı"
      : "Config üretilmedi";

  const runtimeNote =
    domain.runtime_type === "php"
      ? `PHP ${domain.php_version ?? "?"}`
      : domain.runtime_type === "proxy"
        ? `Proxy → :${domain.proxy_port ?? "?"}`
        : "Statik dosyalar";

  const sections: ToolSection[] = [
    {
      title: "Barındırma ve DNS",
      tools: [
        {
          key: "nginx",
          name: "Nginx ayarları",
          note: nginxNote,
          icon: Cog6ToothIcon,
          href: `${base}?tab=nginx`,
        },
        {
          key: "dns",
          name: "DNS bölgesi",
          note: typeof dnsCount === "number" ? `${dnsCount} kayıt` : undefined,
          icon: CloudIcon,
          href: `${base}?tab=dns`,
        },
        {
          key: "ssl",
          name: "SSL/TLS sertifikası",
          note: sslNote,
          icon: LockClosedIcon,
          href: `${base}?tab=ssl`,
        },
        {
          key: "runtime",
          name: "Runtime",
          note: runtimeNote,
          icon: CommandLineIcon,
          href: `${base}?tab=runtime`,
        },
      ],
    },
    {
      title: "Dosyalar ve veriler",
      tools: [
        {
          key: "files",
          name: "Dosya yöneticisi",
          note: domain.directory_exists ? domain.directory_path : "Dizin bulunamadı",
          icon: FolderIcon,
          href: `${base}?tab=files`,
          disabled: !domain.directory_exists,
          disabledReason: "Domain dizini sunucuda yok.",
        },
        {
          key: "ftp",
          name: "FTP hesapları",
          note: "Domain dosyalarına erişim",
          icon: ServerStackIcon,
          href: `${base}?tab=ftp`,
        },
        {
          key: "mail",
          name: "E-posta hesapları",
          // Sayi alinamadiysa not HIC yazilmaz (uydurma sifir gosterilmez).
          note: typeof mailCount === "number" ? `${mailCount} hesap` : undefined,
          icon: EnvelopeIcon,
          href: `${base}?tab=mail`,
        },
        {
          key: "webmail",
          name: "Webmail",
          // Alan adi bazli: webmail.<domain>. Sema burada BILINMIYOR (sertifika
          // durumunu yalnizca sunucu biliyor), bu yuzden panel ici baglanti
          // E-posta sekmesine gider; oradaki buton dogru semayla acar.
          note: "Posta kutularına web üzerinden gir",
          icon: ArrowTopRightOnSquareIcon,
          href: `${base}?tab=mail`,
        },
        {
          key: "databases",
          name: "Veritabanları",
          note: typeof databaseCount === "number" ? `${databaseCount} veritabanı` : undefined,
          icon: CircleStackIcon,
          href: `${base}?tab=databases`,
        },
        {
          key: "backups",
          name: "Yedekler",
          // Dogrulama durumu burada da gorunur: "yedek var" demek yetmez,
          // GERI YUKLENEBILDIGI kanitlanmis mi onemli olan.
          note: backup
            ? `Son yedek ${formatBytes(backup.size_bytes)}` +
              (backup.verify_status === "ok"
                ? " · doğrulandı"
                : backup.verify_status === "failed"
                  ? " · DOĞRULAMA BAŞARISIZ"
                  : " · doğrulanmadı")
            : backup === null
              ? "Yedek alınmadı"
              : undefined,
          icon: ArchiveBoxIcon,
          href: `${base}?tab=backups`,
        },
        {
          key: "config",
          name: "Config önizle",
          note: "Üretilen Nginx dosyası",
          icon: DocumentTextIcon,
          onClick: onGenerateNginx,
        },
      ],
    },
  ];

  if (isAdmin) {
    sections.push({
      title: "Erişim",
      tools: [
        {
          key: "access",
          name: "Müşteri girişi",
          note: domain.has_customer_account ? domain.customer_email ?? "Tanımlı" : "Tanımlı değil",
          icon: UserIcon,
          href: `${base}?tab=access`,
        },
      ],
    });
  }

  return sections;
}
