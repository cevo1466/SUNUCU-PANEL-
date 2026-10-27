"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowTopRightOnSquareIcon, EnvelopeIcon } from "@heroicons/react/24/outline";
import { api, type Domain, type MailListResult } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { DomainGate } from "@/components/domain/DomainPicker";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Badge, LoadingRow, Note } from "@/components/ui/Bits";

/**
 * Tüm domainlerin e-posta özeti — "Hosting servisleri" altındaki genel bakış.
 *
 * Bu sayfa TEK bir soruyu cevaplar: hangi domainde kaç posta kutusu var, ne
 * kadar yer kaplıyor, webmail adresi ne. Kutu açma/silme/kota işlemleri
 * domain detayındaki E-posta sekmesinde KALIR — aynı formu iki yerde tutmak,
 * birinin diğerinden sessizce ayrışması demek olurdu (Yedekler ve SSL genel
 * bakış sayfaları da aynı deseni izliyor).
 */
interface DomainMail {
  /** İstek başarısız olduysa null. */
  data: MailListResult | null;
  error?: string;
}

function usageOf(result: MailListResult): { used: number; unmeasured: number } {
  let used = 0;
  let unmeasured = 0;
  for (const account of result.accounts) {
    // null = ÖLÇÜLEMEDİ. Sıfır saymak "hiç yer kaplamıyor" demek olurdu ve
    // toplamı sessizce küçültürdü; ayrı sayılıp ayrıca bildiriliyor.
    if (account.used_bytes === null) unmeasured += 1;
    else used += account.used_bytes;
  }
  return { used, unmeasured };
}

function MailRow({ domain, info }: { domain: Domain; info: DomainMail | undefined }) {
  const href = `/domains/${domain.id}?tab=mail`;
  const nameCell = (
    <td>
      <Link className="sp-link" href={href}>
        {domain.domain_name}
      </Link>
    </td>
  );

  if (info === undefined) {
    return (
      <tr>
        {nameCell}
        <td colSpan={3} className="sp-hint">
          okunuyor…
        </td>
        <td className="sp-cell-actions" />
      </tr>
    );
  }

  if (!info.data) {
    return (
      <tr>
        {nameCell}
        <td colSpan={3}>
          <Badge tone="err">Okunamadı</Badge> <span className="sp-hint">{info.error}</span>
        </td>
        <td className="sp-cell-actions">
          <Link className="sp-btn sp-btn--secondary sp-btn--sm" href={href}>
            Yönet
          </Link>
        </td>
      </tr>
    );
  }

  const { accounts, webmail } = info.data;
  const { used, unmeasured } = usageOf(info.data);
  const disabled = accounts.filter((account) => !account.enabled).length;

  return (
    <tr>
      {nameCell}
      <td>
        {accounts.length === 0 ? (
          <Badge tone="neutral">Kutu yok</Badge>
        ) : (
          <>
            <strong>{accounts.length}</strong> kutu
            {disabled > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--sp-warn)" }}>{disabled} kapalı</span>
              </>
            )}
          </>
        )}
      </td>
      <td className="sp-num sp-mono" style={{ color: "var(--sp-ink-muted)" }}>
        {accounts.length === 0 ? "—" : formatBytes(used)}
        {unmeasured > 0 && <span className="sp-hint"> · {unmeasured} kutu ölçülemedi</span>}
      </td>
      <td>
        <a className="sp-link" href={webmail.url} target="_blank" rel="noreferrer noopener">
          webmail.{domain.domain_name}
          <ArrowTopRightOnSquareIcon
            aria-hidden="true"
            style={{ width: 13, height: 13, marginLeft: 4, verticalAlign: "-2px" }}
          />
        </a>
        {!webmail.https && (
          <>
            {" "}
            <Badge tone="warn">HTTPS yok</Badge>
          </>
        )}
      </td>
      <td className="sp-cell-actions">
        <Link className="sp-btn sp-btn--secondary sp-btn--sm" href={href}>
          Yönet
        </Link>
      </td>
    </tr>
  );
}

function MailView() {
  const { domains } = useShell();
  const [infos, setInfos] = useState<Record<number, DomainMail>>({});
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async (list: Domain[]) => {
    const results = await Promise.allSettled(list.map((domain) => api.listMailAccounts(domain.id)));
    const next: Record<number, DomainMail> = {};
    results.forEach((result, index) => {
      next[list[index].id] =
        result.status === "fulfilled"
          ? { data: result.value }
          : { data: null, error: (result.reason as Error)?.message ?? "İstek tamamlanmadı." };
    });
    setInfos(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (domains && domains.length > 0) void loadAll(domains);
    else if (domains) setLoading(false);
  }, [domains, loadAll]);

  const loaded = Object.values(infos).filter((info) => info.data);
  const totalBoxes = loaded.reduce((sum, info) => sum + (info.data?.accounts.length ?? 0), 0);
  const totalUsed = loaded.reduce((sum, info) => sum + (info.data ? usageOf(info.data).used : 0), 0);
  // Postfix/Dovecot sunucuda TEK; domain başına değişmez, ilk okunandan alınır.
  const service = loaded[0]?.data?.service ?? null;

  return (
    <>
      <PageHeader title="E-postalar" breadcrumb="Hosting servisleri" />
      <DomainGate domains={domains}>
        {(list) => (
          <div className="sp-stack">
            {service && !service.running && (
              <Note tone="warn">
                {service.note} Hesaplar ve kotalar panelde kayıtlı tutulur; Postfix/Dovecot
                çalışmadan posta gidip gelmez.
              </Note>
            )}

            <Panel>
              <PanelHead
                title={
                  <>
                    <EnvelopeIcon aria-hidden="true" />
                    Posta kutuları
                  </>
                }
                note={
                  loading
                    ? undefined
                    : `${totalBoxes} kutu · ${list.length} domain · toplam ${formatBytes(totalUsed)}`
                }
              />
              <PanelBody flush>
                {loading ? (
                  <LoadingRow label="E-posta bilgileri okunuyor" />
                ) : (
                  <div className="sp-table-wrap">
                    <table className="sp-table">
                      <thead>
                        <tr>
                          <th>Domain</th>
                          <th style={{ width: 160 }}>Kutular</th>
                          <th className="sp-num" style={{ width: 150 }}>
                            Kullanım
                          </th>
                          <th style={{ width: 260 }}>Webmail</th>
                          <th className="sp-cell-actions">İşlem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((domain) => (
                          <MailRow key={domain.id} domain={domain} info={infos[domain.id]} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </PanelBody>
            </Panel>

            <Note>
              Kutu açma, parola değiştirme ve kota ayarları domainin E-posta sekmesinde yapılır.
              Kullanıcılar posta kutusunun tam adresi ve parolasıyla webmail&apos;e girer.
            </Note>
          </div>
        )}
      </DomainGate>
    </>
  );
}

export default function MailPage() {
  return (
    <AppShell>
      <MailView />
    </AppShell>
  );
}
