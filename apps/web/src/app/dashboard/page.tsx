"use client";

import Link from "next/link";
import {
  ArrowRightIcon,
  GlobeAltIcon,
  LockClosedIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import type { Domain } from "@/lib/api";
import { relativeDays } from "@/lib/format";
import { useMetricsHistory } from "@/lib/useMetricsHistory";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { ResourceCharts } from "@/components/chart/ResourceCharts";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Badge, EmptyState, LoadingRow, Note } from "@/components/ui/Bits";
import { DomainStatusBadges } from "@/components/domain/DomainCard";

/** 30 günden az kalmış veya süresi dolmuş sertifikalar. */
function expiringCerts(domains: Domain[]): Domain[] {
  return domains.filter((domain) => {
    if (!domain.ssl_status || !domain.ssl_expiry) return false;
    const daysLeft = (new Date(domain.ssl_expiry).getTime() - Date.now()) / 86_400_000;
    return daysLeft < 30;
  });
}

/**
 * Bir domainin kurulumunda sıradaki adım: NE eksik ve NEREDE tamamlanır.
 *
 * Nginx önce gelir — SSL sertifikası, Let's Encrypt'in HTTP-01 doğrulamasını
 * yapabilmesi için sitenin 80. portta gerçekten yayında olmasını gerektirir.
 */
function nextStep(domain: Domain): { reason: string; action: string; tab: string } {
  if (!domain.nginx_deployed) {
    return {
      reason: domain.config_generated
        ? "Config üretildi, henüz Nginx'e alınmadı"
        : "Nginx config'i henüz üretilmedi",
      action: "Nginx'i tamamla",
      tab: "nginx",
    };
  }
  return { reason: "SSL sertifikası yok", action: "Sertifika al", tab: "ssl" };
}

function DashboardView() {
  const { domains, domainsError } = useShell();
  // Panel özetinde sabit 30 dakika: aralık seçici /server sayfasında.
  const { history, latest, error } = useMetricsHistory("30m");

  const needsAttention = domains?.filter((d) => !d.nginx_deployed || !d.ssl_status) ?? [];
  const expiring = domains ? expiringCerts(domains) : [];

  return (
    <>
      <PageHeader
        title="Panel özeti"
        breadcrumb="Genel"
        actions={
          <Link className="sp-btn sp-btn--primary" href="/domains">
            <PlusIcon aria-hidden="true" />
            Domain ekle
          </Link>
        }
      />

      <div className="sp-stack">
        {(error || domainsError) && <Note tone="warn">{error ?? domainsError}</Note>}

        {expiring.length > 0 && (
          <Note tone="warn">
            <strong>{expiring.length} sertifikanın süresi 30 günden az kaldı:</strong>{" "}
            {expiring.map((domain) => domain.domain_name).join(", ")}.{" "}
            <Link className="sp-link" href="/ssl">
              SSL sayfasına git
            </Link>
          </Note>
        )}

        <ResourceCharts
          history={history}
          latest={latest}
          range="30m"
          onRangeChange={() => undefined}
          compact
        />

        <div className="sp-split">
          <Panel>
            <PanelHead
              title={
                <>
                  <GlobeAltIcon aria-hidden="true" />
                  Domainler
                </>
              }
              actions={
                <Link className="sp-link sp-row" href="/domains" style={{ gap: 4 }}>
                  Tümünü gör
                  <ArrowRightIcon style={{ width: 13, height: 13 }} aria-hidden="true" />
                </Link>
              }
            />
            <PanelBody flush>
              {domains === null ? (
                <LoadingRow label="Domainler yükleniyor" />
              ) : domains.length === 0 ? (
                <EmptyState
                  icon={GlobeAltIcon}
                  title="Henüz domain yok"
                  text="İlk domaininizi ekleyin; dizin yapısı ve Nginx config'i panelden yönetilir."
                  action={
                    <Link className="sp-btn sp-btn--primary" href="/domains">
                      Domain ekle
                    </Link>
                  }
                />
              ) : (
                <div className="sp-table-wrap">
                  <table className="sp-table">
                    <thead>
                      <tr>
                        <th>Domain</th>
                        <th>Durum</th>
                        <th className="sp-cell-actions">İşlem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {domains.slice(0, 8).map((domain) => (
                        <tr key={domain.id}>
                          <td>
                            <Link className="sp-link" href={`/domains/${domain.id}`}>
                              {domain.domain_name}
                            </Link>
                            <div className="sp-mono sp-tile-note">{domain.directory_path}</div>
                          </td>
                          <td>
                            <div className="sp-row" style={{ gap: 5 }}>
                              <DomainStatusBadges domain={domain} />
                            </div>
                          </td>
                          <td className="sp-cell-actions">
                            <Link
                              className="sp-btn sp-btn--secondary sp-btn--sm"
                              href={`/domains/${domain.id}`}
                            >
                              Yönet
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </PanelBody>
          </Panel>

          <div className="sp-stack">
            <Panel>
              <PanelHead title="Kurulum durumu" />
              <PanelBody flush>
                <table className="sp-table">
                  <tbody>
                    <tr>
                      <th>Toplam domain</th>
                      <td className="sp-num sp-mono">{domains?.length ?? "—"}</td>
                    </tr>
                    <tr>
                      <th>Dizini hazır</th>
                      <td className="sp-num sp-mono">
                        {domains?.filter((d) => d.directory_exists).length ?? "—"}
                      </td>
                    </tr>
                    <tr>
                      <th>Nginx&apos;te yayında</th>
                      <td className="sp-num sp-mono">
                        {domains?.filter((d) => d.nginx_deployed).length ?? "—"}
                      </td>
                    </tr>
                    <tr>
                      <th>SSL etkin</th>
                      <td className="sp-num sp-mono">
                        {domains?.filter((d) => d.ssl_status).length ?? "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </PanelBody>
            </Panel>

            {needsAttention.length > 0 && (
              <Panel>
                <PanelHead
                  title={
                    <>
                      <LockClosedIcon aria-hidden="true" />
                      Tamamlanmayı bekleyen
                    </>
                  }
                  note={`${needsAttention.length} domain`}
                />
                <PanelBody flush>
                  <table className="sp-table">
                    <tbody>
                      {needsAttention.slice(0, 6).map((domain) => {
                        const step = nextStep(domain);
                        return (
                          <tr key={domain.id}>
                            <td>
                              <Link className="sp-link" href={`/domains/${domain.id}`}>
                                {domain.domain_name}
                              </Link>
                              {/* Eksik olanın NE olduğu yazılır. Önceden yalnızca
                                  tek kelimelik bir "Nginx" butonu vardı ve etiket
                                  mi buton mu olduğu anlaşılmıyordu. */}
                              <div className="sp-hint">{step.reason}</div>
                            </td>
                            <td className="sp-cell-actions">
                              <Link
                                className="sp-btn sp-btn--secondary sp-btn--sm"
                                href={`/domains/${domain.id}?tab=${step.tab}`}
                              >
                                {step.action}
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </PanelBody>
              </Panel>
            )}

            {domains && domains.length > 0 && needsAttention.length === 0 && (
              <Panel>
                <PanelBody>
                  <div className="sp-row" style={{ gap: 8 }}>
                    <Badge tone="ok">Hazır</Badge>
                    <span className="sp-hint">
                      Bütün domainlerin Nginx ve SSL kurulumu tamamlanmış.
                      {expiring.length === 0 &&
                        domains.some((d) => d.ssl_expiry) &&
                        ` En yakın sertifika yenilemesi ${
                          relativeDays(
                            domains
                              .filter((d) => d.ssl_expiry)
                              .sort(
                                (a, b) =>
                                  new Date(a.ssl_expiry as string).getTime() -
                                  new Date(b.ssl_expiry as string).getTime(),
                              )[0].ssl_expiry,
                          ) ?? ""
                        }.`}
                    </span>
                  </div>
                </PanelBody>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default function DashboardPage() {
  return (
    <AppShell>
      <DashboardView />
    </AppShell>
  );
}
