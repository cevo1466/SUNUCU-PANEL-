"use client";

import Link from "next/link";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import type { Domain } from "@/lib/api";
import { formatDate, relativeDays } from "@/lib/format";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { DomainGate } from "@/components/domain/DomainPicker";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Badge, Note } from "@/components/ui/Bits";

/** Sertifika durumu: yok / geçerli / 30 günden az kaldı / süresi dolmuş. */
function certState(domain: Domain): { tone: "ok" | "warn" | "err" | "neutral"; label: string } {
  if (!domain.ssl_status) return { tone: "neutral", label: "Sertifika yok" };
  if (!domain.ssl_expiry) return { tone: "ok", label: "Geçerli" };
  const daysLeft = (new Date(domain.ssl_expiry).getTime() - Date.now()) / 86_400_000;
  if (daysLeft < 0) return { tone: "err", label: "Süresi doldu" };
  if (daysLeft < 30) return { tone: "warn", label: "Yakında bitiyor" };
  return { tone: "ok", label: "Geçerli" };
}

function SslView() {
  const { domains } = useShell();

  return (
    <>
      <PageHeader title="SSL sertifikaları" breadcrumb="Hosting servisleri" />
      <DomainGate domains={domains}>
        {(list) => {
          const expiringSoon = list.filter((domain) => {
            const state = certState(domain);
            return state.tone === "warn" || state.tone === "err";
          });

          return (
            <div className="sp-stack">
              {expiringSoon.length > 0 && (
                <Note tone="warn">
                  {expiringSoon.length} sertifikanın süresi dolmuş veya 30 günden az kalmış:{" "}
                  {expiringSoon.map((domain) => domain.domain_name).join(", ")}. Otomatik yenileme
                  gecelik çalışır; beklemeden yenilemek için domainin SSL sekmesinden
                  &quot;Sertifikayı yenile&quot; deyin.
                </Note>
              )}

              <Panel>
                <PanelHead
                  title={
                    <>
                      <LockClosedIcon aria-hidden="true" />
                      Sertifika durumu
                    </>
                  }
                  note={`${list.filter((d) => d.ssl_status).length} / ${list.length} domainde etkin`}
                />
                <PanelBody flush>
                  <div className="sp-table-wrap">
                    <table className="sp-table">
                      <thead>
                        <tr>
                          <th>Domain</th>
                          <th style={{ width: 150 }}>Durum</th>
                          <th style={{ width: 180 }}>Bitiş tarihi</th>
                          <th className="sp-cell-actions">İşlem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((domain) => {
                          const state = certState(domain);
                          const relative = relativeDays(domain.ssl_expiry);
                          return (
                            <tr key={domain.id}>
                              <td>
                                <Link className="sp-link" href={`/domains/${domain.id}?tab=ssl`}>
                                  {domain.domain_name}
                                </Link>
                              </td>
                              <td>
                                <Badge tone={state.tone}>{state.label}</Badge>
                              </td>
                              <td style={{ color: "var(--sp-ink-muted)" }}>
                                {domain.ssl_expiry ? (
                                  <>
                                    {formatDate(domain.ssl_expiry)}
                                    {relative && ` · ${relative}`}
                                  </>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="sp-cell-actions">
                                <Link
                                  className="sp-btn sp-btn--secondary sp-btn--sm"
                                  href={`/domains/${domain.id}?tab=ssl`}
                                >
                                  Yönet
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </PanelBody>
              </Panel>

              <Note>
                Sertifika, domainin SSL sekmesindeki &quot;Sertifikayı al ve kur&quot; butonuyla
                alınır ve nginx&apos;e kurulur; bitiş tarihi sertifikadan okunur. Süresi dolmadan
                30 gün önce otomatik yenilenir.
              </Note>
            </div>
          );
        }}
      </DomainGate>
    </>
  );
}

export default function SslPage() {
  return (
    <AppShell>
      <SslView />
    </AppShell>
  );
}
