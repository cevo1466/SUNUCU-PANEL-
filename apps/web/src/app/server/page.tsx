"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowPathIcon,
  ClockIcon,
  LockClosedIcon,
  ServerStackIcon,
  SignalIcon,
} from "@heroicons/react/24/outline";
import { api, ApiError, type ServerHealth, type UptimeMetrics } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { AppShell, PageHeader } from "@/components/layout/AppShell";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Badge, EmptyState, LoadingRow, Note } from "@/components/ui/Bits";
import { Button } from "@/components/ui/button";

/**
 * Sunucu sağlığı.
 *
 * NEDEN KAYNAK GRAFİĞİ YOK: bu sayfa daha önce Panel özeti'ndeki `ResourceCharts`
 * bileşenini birebir tekrar ediyordu; kullanıcı haklı olarak "ikisi aynı
 * görünüyor" dedi. Grafikler artık yalnızca Panel özeti'nde.
 *
 * YERİNE NE VAR: panelin 12 servisi, sunucudaki sertifikaların TAMAMI ve
 * zamanlanmış işler — üçü de panelde hiçbir yerde görünmüyordu. Bu oturumda
 * bulunan ciddi hataların çoğu tam olarak bu körlükten çıktı: php-fpm hiç
 * kurulu değildi, OpenDKIM tabloları okumuyordu, üç sertifika hiç
 * yenilenmiyordu. Hiçbiri panelde belli olmuyordu.
 */
function ServicesPanel({ health }: { health: ServerHealth | null }) {
  const down = health?.services.filter((service) => !service.running) ?? [];
  return (
    <Panel>
      <PanelHead
        title={
          <>
            <ServerStackIcon aria-hidden="true" />
            Servisler
          </>
        }
        note={
          health
            ? down.length === 0
              ? `${health.services.length} servisin hepsi çalışıyor`
              : `${down.length} servis çalışmıyor`
            : undefined
        }
      />
      <PanelBody flush>
        {!health ? (
          <LoadingRow label="Servisler ölçülüyor" />
        ) : (
          <div className="sp-table-wrap">
            <table className="sp-table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Durum</th>
                  <th>Servis</th>
                  <th>Ne işe yarar</th>
                  <th className="sp-num" style={{ width: 150 }}>
                    Adres
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.services.map((service) => (
                  <tr key={service.name}>
                    <td>
                      <Badge tone={service.running ? "ok" : "err"}>
                        {service.running ? "Çalışıyor" : "Çalışmıyor"}
                      </Badge>
                    </td>
                    <td>
                      <strong>{service.label}</strong>
                    </td>
                    <td style={{ color: "var(--sp-ink-muted)" }}>{service.role}</td>
                    <td className="sp-num sp-mono" style={{ color: "var(--sp-ink-muted)" }}>
                      {service.host}:{service.port}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

/** Sertifika bitişine kalan gün: 30 altı uyarı, 10 altı hata. */
function certTone(daysLeft: number): "ok" | "warn" | "err" {
  if (daysLeft < 10) return "err";
  if (daysLeft < 30) return "warn";
  return "ok";
}

function CertificatesPanel({ health }: { health: ServerHealth | null }) {
  return (
    <Panel>
      <PanelHead
        title={
          <>
            <LockClosedIcon aria-hidden="true" />
            Sertifikalar
          </>
        }
        note={health ? `${health.certificates.length} sertifika` : undefined}
      />
      <PanelBody flush>
        {!health ? (
          <LoadingRow label="Sertifikalar okunuyor" />
        ) : health.certificateError ? (
          // Okunamayan listeyi "sertifika yok" diye göstermek, bu panelde
          // tekrar eden hata: kaydın yokluğunu gerçeğin yokluğu sanmak.
          <div style={{ padding: "12px 14px" }}>
            <Note tone="warn">Sertifika listesi okunamadı: {health.certificateError}</Note>
          </div>
        ) : health.certificates.length === 0 ? (
          <EmptyState icon={LockClosedIcon} title="Sunucuda sertifika yok" />
        ) : (
          <div className="sp-table-wrap">
            <table className="sp-table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Kalan süre</th>
                  <th>Sertifika</th>
                  <th>Kapsadığı adresler</th>
                  <th style={{ width: 130 }}>Bitiş</th>
                </tr>
              </thead>
              <tbody>
                {health.certificates.map((cert) => (
                  <tr key={cert.name}>
                    <td>
                      <Badge tone={certTone(cert.daysLeft)}>{cert.daysLeft} gün</Badge>
                    </td>
                    <td className="sp-mono">{cert.name}</td>
                    <td style={{ color: "var(--sp-ink-muted)" }}>
                      {cert.domains.join(", ") || "—"}
                    </td>
                    <td style={{ color: "var(--sp-ink-muted)" }}>{formatDate(cert.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function JobsPanel({ health }: { health: ServerHealth | null }) {
  return (
    <Panel>
      <PanelHead
        title={
          <>
            <ClockIcon aria-hidden="true" />
            Zamanlanmış işler
          </>
        }
        note={health ? `${health.jobs.length} iş` : undefined}
      />
      <PanelBody flush>
        {!health ? (
          <LoadingRow label="Zamanlanmış işler okunuyor" />
        ) : health.jobsError ? (
          <div style={{ padding: "12px 14px" }}>
            <Note tone="warn">Zamanlanmış işler okunamadı: {health.jobsError}</Note>
          </div>
        ) : health.jobs.length === 0 ? (
          <EmptyState
            icon={ClockIcon}
            title="Zamanlanmış iş yok"
            text="Yedekleme ve SSL yenilemesi çalışmıyor demektir."
          />
        ) : (
          <>
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th>İş</th>
                    <th style={{ width: 130 }}>Zamanlama</th>
                    <th style={{ width: 210 }}>Son çıktı</th>
                  </tr>
                </thead>
                <tbody>
                  {health.jobs.map((job) => (
                    <tr key={`${job.label}-${job.schedule}`}>
                      <td>
                        <strong>{job.label}</strong>
                        {!job.enabled && <span className="sp-hint"> (kapalı)</span>}
                        {job.quiet && (
                          <>
                            {" "}
                            <span className="sp-hint">(sessiz)</span>
                          </>
                        )}
                      </td>
                      <td className="sp-mono" style={{ color: "var(--sp-ink-muted)" }}>
                        {job.schedule}
                      </td>
                      <td style={{ color: "var(--sp-ink-muted)" }}>
                        {job.lastOutputAt ? formatDateTime(job.lastOutputAt) : "hiç yazmadı"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: "10px 14px 12px" }}>
              <Note>
                <strong>Son çıktı, son çalışma değildir.</strong> &quot;Sessiz&quot; işaretli
                gözetmenler her dakika çalışır ama yalnızca gerçekten müdahale ettiklerinde
                yazarlar. Uzun süre yazmamış olmaları iyiye işarettir — düzeltilecek bir şey
                çıkmamış demektir.
              </Note>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

/** HetrixTools durum metnini panelin diline çevirir. */
function uptimeTone(status: string): { tone: "ok" | "err" | "warn" | "neutral"; label: string } {
  const value = status.toLowerCase();
  if (value === "up" || value === "online") return { tone: "ok", label: "Çalışıyor" };
  if (value === "down" || value === "offline") return { tone: "err", label: "Erişilemiyor" };
  if (value === "maintenance") return { tone: "warn", label: "Bakımda" };
  return { tone: "neutral", label: status };
}

function UptimePanel() {
  const [uptime, setUptime] = useState<UptimeMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .uptimeMetrics()
      .then((result) => !cancelled && setUptime(result))
      .catch(() => !cancelled && setUptime({ status: "error", httpStatus: 0, message: "İstek başarısız." }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Panel>
      <PanelHead
        title={
          <>
            <SignalIcon aria-hidden="true" />
            Uptime izleme
          </>
        }
        note="HetrixTools"
      />
      <PanelBody flush>
        {uptime === null ? (
          <LoadingRow label="Monitörler okunuyor" />
        ) : uptime.status === "not_configured" ? (
          <div style={{ padding: 14 }}>
            <Note>
              HetrixTools bağlanmadı. VDS&apos;deki{" "}
              <span className="sp-mono">/opt/studio-panel-installer/.env</span> dosyasına kendi{" "}
              <span className="sp-mono">HETRIX_API_KEY</span> anahtarınızı ekleyin. Ardından kurulum
              dizininde <span className="sp-mono">sudo docker compose --env-file .env up -d</span>{" "}
              çalıştırın.
            </Note>
          </div>
        ) : uptime.status === "error" ? (
          <div style={{ padding: 14 }}>
            <Note tone="warn">HetrixTools yanıt vermedi: {uptime.message}</Note>
          </div>
        ) : uptime.monitors.length === 0 ? (
          <EmptyState
            icon={SignalIcon}
            title="Tanımlı monitör yok"
            text="HetrixTools hesabınızda bu sunucu için bir monitör oluşturun."
          />
        ) : (
          <div className="sp-table-wrap">
            <table className="sp-table">
              <thead>
                <tr>
                  <th>Monitör</th>
                  <th>Hedef</th>
                  <th style={{ width: 140 }}>Durum</th>
                </tr>
              </thead>
              <tbody>
                {uptime.monitors.map((monitor) => {
                  const { tone, label } = uptimeTone(monitor.uptime_status);
                  return (
                    <tr key={monitor.id}>
                      <td>{monitor.name}</td>
                      <td className="sp-mono" style={{ color: "var(--sp-ink-muted)" }}>
                        {monitor.target}
                      </td>
                      <td>
                        <Badge tone={tone}>{label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

export default function ServerPage() {
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setHealth(await api.serverHealth());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sunucu durumu okunamadı.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const down = health?.services.filter((service) => !service.running) ?? [];
  const expiring = health?.certificates.filter((cert) => cert.daysLeft < 30) ?? [];

  return (
    <AppShell>
      <PageHeader
        title="Sunucu sağlığı"
        breadcrumb="Sunucu"
        actions={
          <Button variant="secondary" size="sm" onClick={load} loading={refreshing}>
            <ArrowPathIcon aria-hidden="true" />
            Yenile
          </Button>
        }
      />
      <div className="sp-stack">
        {error && <Note tone="warn">{error}</Note>}
        {down.length > 0 && (
          <Note tone="err">
            <strong>{down.length} servis çalışmıyor:</strong>{" "}
            {down.map((service) => service.label).join(", ")}. Sunucuda{" "}
            <span className="sp-mono">ops/scripts/boot.sh</span> çalıştırmak çoğunu geri getirir.
          </Note>
        )}
        {expiring.length > 0 && (
          <Note tone="warn">
            {expiring.length} sertifikanın süresi 30 günden az kaldı:{" "}
            {expiring.map((cert) => `${cert.name} (${cert.daysLeft} gün)`).join(", ")}. Yenileme
            gecelik çalışır; beklemeden yenilemek için{" "}
            <span className="sp-mono">sudo ops/scripts/ssl-renew.sh</span>.
          </Note>
        )}
        <ServicesPanel health={health} />
        <CertificatesPanel health={health} />
        <JobsPanel health={health} />
        <UptimePanel />
      </div>
    </AppShell>
  );
}
