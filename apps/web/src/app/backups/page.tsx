"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArchiveBoxIcon, ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type BackupSchedule, type BackupVersion, type Domain } from "@/lib/api";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/useElapsedSeconds";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { DomainGate } from "@/components/domain/DomainPicker";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, LoadingRow, Note } from "@/components/ui/Bits";
import { useToast } from "@/components/ui/Toast";

/**
 * Genel bakis satiri: her domainin EN SON yedegi ve DOGRULAMA durumu.
 * Surum listesi ve geri yukleme domain detayindaki Yedekler sekmesinde —
 * bu sayfa "hangi domainin yedegi eksik/dogrulanmamis" sorusunu cevaplar.
 */
function BackupRow({
  domain,
  info,
  onCreated,
}: {
  domain: Domain;
  /** undefined = henuz okunmadi, null = hic yedek yok. */
  info: BackupVersion | null | undefined;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const elapsed = useElapsedSeconds(busy);

  async function create() {
    setBusy(true);
    try {
      const result = await api.createBackup(domain.id);
      onCreated();
      if (result.complete) {
        toast.ok("Yedek alındı", `${result.name} · ${formatBytes(result.size_bytes)}`);
      } else {
        toast.error("Yedek EKSİK alındı", result.warnings.join(" · "));
      }
    } catch (err) {
      toast.error("Yedek alınamadı", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <Link className="sp-link" href={`/domains/${domain.id}?tab=backups`}>
          {domain.domain_name}
        </Link>
      </td>
      <td>
        {info === undefined ? (
          <span className="sp-hint">okunuyor…</span>
        ) : info === null ? (
          <Badge tone="neutral">Yedek yok</Badge>
        ) : info.verify_status === "ok" ? (
          // YESIL YALNIZCA DOGRULANMISA: yedegin var olmasi degil, geri
          // yuklenebildiginin KANITLANMIS olmasi guven verir.
          <Badge tone="ok">Doğrulandı</Badge>
        ) : info.verify_status === "failed" ? (
          <Badge tone="err">Doğrulama başarısız</Badge>
        ) : (
          <Badge tone="warn">Doğrulanmadı</Badge>
        )}
      </td>
      <td className="sp-num sp-mono" style={{ color: "var(--sp-ink-muted)" }}>
{info ? formatBytes(info.size_bytes) : "—"}
      </td>
      <td style={{ color: "var(--sp-ink-muted)" }}>
{info ? formatDateTime(info.created_at) : "—"}
      </td>
      <td className="sp-cell-actions">
        <Button size="sm" variant="primary" onClick={create} loading={busy}>
{busy
            ? elapsed < 10
              ? "Alınıyor…"
              : `Alınıyor… ${formatDuration(elapsed)} (büyük sitelerde dakikalar sürebilir)`
            : info
              ? "Yeni sürüm al"
              : "Yedek al"}
        </Button>
        {info && (
          <ButtonLink
            size="sm"
            variant="secondary"
            href={api.backupDownloadUrl(domain.id, info.name)}
            download={`${domain.domain_name}-${info.name}`}
          >
            <ArrowDownTrayIcon aria-hidden="true" />
            İndir
          </ButtonLink>
        )}
      </td>
    </tr>
  );
}

function BackupsView() {
  const { domains, user } = useShell();
  const toast = useToast();
  const [infos, setInfos] = useState<Record<number, BackupVersion | null>>({});
  const [loading, setLoading] = useState(true);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const loadAll = useCallback(async (list: Domain[]) => {
    const results = await Promise.allSettled(list.map((domain) => api.listBackups(domain.id)));
    const next: Record<number, BackupVersion | null> = {};
    results.forEach((result, index) => {
      // En son surum; hic yoksa null (undefined "henuz okunmadi" demek).
      if (result.status === "fulfilled") next[list[index].id] = result.value.backups[0] ?? null;
    });
    setInfos(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (domains && domains.length > 0) void loadAll(domains);
    else if (domains) setLoading(false);
  }, [domains, loadAll]);

  useEffect(() => {
    if (user?.role !== "admin") return;
    void api.backupSchedule().then(setSchedule).catch((err) => {
      setScheduleError(err instanceof ApiError ? err.message : "Zamanlayıcı okunamadı.");
    });
  }, [user?.role]);

  async function toggleSchedule() {
    if (!schedule) return;
    setScheduleBusy(true);
    try {
      const next = await api.setBackupSchedule(!schedule.enabled);
      setSchedule(next);
      setScheduleError(null);
      toast.ok(next.enabled ? "Otomatik yedekleme açıldı" : "Otomatik yedekleme kapatıldı",
        next.enabled ? "Her gün 02:40 UTC; doğrulama pazar 04:20 UTC." : "Elle yedek alma kullanılabilir.");
    } catch (err) {
      toast.error("Zamanlayıcı değiştirilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setScheduleBusy(false);
    }
  }

  const total = Object.values(infos).reduce((sum, info) => sum + (info?.size_bytes ?? 0), 0);
  const withBackup = Object.values(infos).filter((info) => info !== null).length;

  return (
    <>
      <PageHeader title="Yedekler" breadcrumb="Hosting servisleri" />
      {user?.role === "admin" && (
        <Panel>
          <PanelHead
            title="Otomatik yedekleme"
            note={schedule ? (schedule.enabled ? "Açık" : "Kapalı") : "Okunuyor…"}
            actions={schedule && (
              <Button size="sm" variant={schedule.enabled ? "secondary" : "primary"}
                loading={scheduleBusy} onClick={() => void toggleSchedule()}>
                {schedule.enabled ? "Otomatik yedeklemeyi kapat" : "Otomatik yedeklemeyi aç"}
              </Button>
            )}
          />
          <PanelBody>
            <p>Etkin olduğunda tüm domainler her gün 02:40 UTC’de yedeklenir; son yedekler pazar 04:20 UTC’de doğrulanır. Elle yedek alma her zaman kullanılabilir.</p>
            {scheduleError && <Note>{scheduleError}</Note>}
          </PanelBody>
        </Panel>
      )}
      <DomainGate domains={domains}>
        {(list) => (
          <div className="sp-stack">
            <Panel>
              <PanelHead
                title={
                  <>
                    <ArchiveBoxIcon aria-hidden="true" />
                    Domain yedekleri
                  </>
                }
                note={
                  loading
                    ? undefined
                    : `${withBackup} / ${list.length} domainde yedek · toplam ${formatBytes(total)}`
                }
              />
              <PanelBody flush>
                {loading ? (
                  <LoadingRow label="Yedek bilgileri okunuyor" />
                ) : (
                  <div className="sp-table-wrap">
                    <table className="sp-table">
                      <thead>
                        <tr>
                          <th>Domain</th>
                          <th style={{ width: 120 }}>Durum</th>
                          <th className="sp-num" style={{ width: 110 }}>
                            Boyut
                          </th>
                          <th style={{ width: 180 }}>Alınma zamanı</th>
                          <th className="sp-cell-actions">İşlem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((domain) => (
                          <BackupRow
                            key={domain.id}
                            domain={domain}
                            info={infos[domain.id]}
                            // Yedek alindiktan sonra SATIRI YENIDEN OKUYORUZ:
                            // POST cevabi dogrulama durumunu icermez (yeni
                            // yedek henuz dogrulanmamistir) ve onu iyimser
                            // sekilde yazmak "dogrulandi" yanilgisi yaratirdi.
                            onCreated={() => void loadAll(list)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </PanelBody>
            </Panel>

            <Note>
              Her domain için son sürümler saklanır; doğrulanmış sürümler otomatik silinmez. Yedekler
              sunucunun kendi diskinde durur — kalıcı saklama için indirip dışarı alın.
            </Note>
          </div>
        )}
      </DomainGate>
    </>
  );
}

export default function BackupsPage() {
  return (
    <AppShell>
      <BackupsView />
    </AppShell>
  );
}
