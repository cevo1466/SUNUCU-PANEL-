import type { ComponentType, SVGProps } from "react";
import {
  ArchiveBoxIcon,
  CircleStackIcon,
  CloudIcon,
  EnvelopeIcon,
  FolderIcon,
  GlobeAltIcon,
  LockClosedIcon,
  ServerStackIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";

export type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Üst bar aramasında eşleşmeyi artıran ek terimler. */
  keywords: string[];
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * Tek navigasyon kaynağı. Sol menü, mobil çekmece ve üst bar araması aynı
 * diziyi okur — bir sayfa eklendiğinde üçü birden güncellenir ve menüde
 * hiçbir zaman gitmeyen bir bağlantı kalmaz.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Genel",
    items: [
      {
        href: "/dashboard",
        label: "Panel özeti",
        icon: Squares2X2Icon,
        keywords: ["dashboard", "genel", "ozet", "özet", "durum"],
      },
    ],
  },
  {
    title: "Web siteleri",
    items: [
      {
        href: "/domains",
        label: "Domainler",
        icon: GlobeAltIcon,
        keywords: ["domain", "alan adi", "alan adı", "site", "vhost"],
      },
    ],
  },
  {
    title: "Hosting servisleri",
    items: [
      {
        href: "/files",
        label: "Dosya yöneticisi",
        icon: FolderIcon,
        keywords: ["dosya", "file", "klasor", "klasör", "dizin", "upload"],
      },
      {
        href: "/databases",
        label: "Veritabanları",
        icon: CircleStackIcon,
        keywords: ["veritabani", "veritabanı", "database", "db", "postgres", "postgresql", "mysql", "mariadb", "sql"],
      },
      {
        href: "/mail",
        label: "E-postalar",
        icon: EnvelopeIcon,
        keywords: ["eposta", "e-posta", "email", "mail", "posta", "kutu", "webmail", "imap", "smtp"],
      },
      {
        href: "/dns",
        label: "DNS kayıtları",
        icon: CloudIcon,
        keywords: ["dns", "a", "cname", "txt", "mx", "cloudflare", "zone"],
      },
      {
        href: "/ssl",
        label: "SSL sertifikaları",
        icon: LockClosedIcon,
        keywords: ["ssl", "tls", "sertifika", "https", "certbot", "lets encrypt"],
      },
      {
        href: "/backups",
        label: "Yedekler",
        icon: ArchiveBoxIcon,
        keywords: ["yedek", "backup", "tar", "arsiv", "arşiv", "indir"],
      },
    ],
  },
  {
    title: "Sunucu",
    items: [
      {
        href: "/server",
        label: "Sunucu sağlığı",
        icon: ServerStackIcon,
        keywords: [
          "sunucu", "servis", "saglik", "sağlık", "durum", "sertifika", "cron",
          "zamanlanmis", "zamanlanmış", "uptime", "izleme", "hetrix",
        ],
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Aktif menü öğesi. /domains/12 gibi alt yollar üst öğeyi işaretler. */
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === pathname) return true;
  return pathname.startsWith(`${href}/`);
}
