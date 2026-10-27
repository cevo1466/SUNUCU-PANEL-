"use client";

import Link from "next/link";
import { ArrowTopRightOnSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { BackupVersion, Domain, DomainDiskUsage } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Bits";
import { Button } from "@/components/ui/button";
import { ToolGrid } from "./ToolGrid";
import { buildDomainTools } from "./domainTools";

export function DomainStatusBadges({ domain }: { domain: Domain }) {
  return (
    <>
      <Badge tone={domain.directory_exists ? "ok" : "warn"}>
        {domain.directory_exists ? "Dizin hazır" : "Dizin yok"}
      </Badge>
      <Badge tone={domain.nginx_deployed ? "ok" : domain.config_generated ? "info" : "neutral"}>
        {domain.nginx_deployed
          ? "Nginx'te yayında"
          : domain.config_generated
            ? "Config hazır"
            : "Config yok"}
      </Badge>
      <Badge tone={domain.ssl_status ? "ok" : "neutral"}>
        {domain.ssl_status ? "SSL etkin" : "SSL yok"}
      </Badge>
    </>
  );
}

/**
 * Plesk'in "Websites & Domains" kartı: alan adı, durumu ve bütün yönetim
 * araçları tek kutuda. Araçlar açılır menüde saklı değil, doğrudan görünür.
 */
/**
 * Domain dizininin disk kullanımı — kart üst bilgisinde tek satır.
 *
 * Üç durumu AYIRIR, hepsini "—" ile geçiştirmez:
 *   undefined → ölçüm henüz gelmedi (ayrı ve yavaş bir istek)
 *   missing   → dizin yok, gerçekten 0
 *   error     → ölçülemedi; sebebi title'da duruyor
 * Bu ayrım önemli: "0 B" ile "ölçemedim" aynı şey değil ve ikincisini sıfır
 * gibi göstermek kullanıcıyı yanıltır.
 */
function DiskUsageLabel({ usage }: { usage?: DomainDiskUsage | null }) {
  if (usage === undefined) return <span className="sp-domain-disk">disk ölçülüyor…</span>;
  if (usage === null) return null;
  if (usage.error) {
    return (
      <span className="sp-domain-disk" title={usage.error}>
        disk: ölçülemedi
      </span>
    );
  }
  if (usage.missing) return <span className="sp-domain-disk">disk: dizin yok</span>;
  return (
    <span className="sp-domain-disk">
      disk: <strong>{formatBytes(usage.bytes ?? 0)}</strong>
    </span>
  );
}

export function DomainCard({
  domain,
  dnsCount,
  backup,
  diskUsage,
  onGenerateNginx,
  onDelete,
  isAdmin,
}: {
  domain: Domain;
  dnsCount?: number;
  backup?: BackupVersion | null;
  /** undefined = henüz ölçülmedi, null = gösterme. */
  diskUsage?: DomainDiskUsage | null;
  onGenerateNginx: () => void;
  onDelete?: () => void;
  isAdmin?: boolean;
}) {
  const sections = buildDomainTools({ domain, dnsCount, backup, onGenerateNginx, isAdmin });

  return (
    <Panel>
      <div className="sp-domain-head">
        <div style={{ minWidth: 0 }}>
          <Link href={`/domains/${domain.id}`} className="sp-domain-name">
            {domain.domain_name}
          </Link>
          <p className="sp-domain-meta">
            <span className="sp-mono">{domain.directory_path}</span> · {formatDate(domain.created_at)}{" "}
            tarihinde eklendi
            {diskUsage !== null && (
              <>
                {" · "}
                <DiskUsageLabel usage={diskUsage} />
              </>
            )}
          </p>
        </div>

        <div className="sp-row" style={{ gap: 6 }}>
          <DomainStatusBadges domain={domain} />
        </div>

        <div className="sp-domain-head-actions">
          <a
            className="sp-btn sp-btn--ghost sp-btn--sm"
            href={`http://${domain.domain_name}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ArrowTopRightOnSquareIcon aria-hidden="true" />
            Siteyi aç
          </a>
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label={`${domain.domain_name} domainini sil`}
            >
              <TrashIcon aria-hidden="true" />
              Sil
            </Button>
          )}
        </div>
      </div>

      <ToolGrid sections={sections} />
    </Panel>
  );
}
