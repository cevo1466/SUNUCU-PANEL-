"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowPathIcon, CircleStackIcon, GlobeAltIcon, PlusIcon } from "@heroicons/react/24/outline";
import {
  api,
  ApiError,
  type DiskUsageResponse,
  type Domain,
  type DnsProvider,
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { DomainCard } from "@/components/domain/DomainCard";
import { Panel, PanelBody } from "@/components/ui/Panel";
import { Button } from "@/components/ui/button";
import { EmptyState, Field, LoadingRow, Note } from "@/components/ui/Bits";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { NginxConfigView } from "@/components/features/NginxPanel";
import { useToast } from "@/components/ui/Toast";

/**
 * Domainlerin toplam disk kullanımı + en büyükten küçüğe pay çubuğu.
 *
 * NEDEN PAY ÇUBUĞU: kullanıcının sorusu "her domain ne kadar yer kaplıyor"
 * idi; ham sayılar bunu cevaplar ama hangisinin diski yediğini tek bakışta
 * göstermez. Çubuk, TOPLAM İÇİNDEKİ payı verir — sunucu diskindeki payı
 * değil (o başka bir ölçü, Sunucu sayfasındaki cgroup metriklerinde duruyor).
 * Çubuğun yanında her zaman sayı da var; renk/uzunluk tek başına bilgi
 * taşımıyor.
 */
function DiskUsageSummary({
  usage,
  error,
  loading,
  onRefresh,
}: {
  usage: DiskUsageResponse | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (error) {
    return <Note tone="warn">Disk kullanımı okunamadı: {error}</Note>;
  }
  if (!usage) {
    return (
      <Panel>
        <PanelBody flush>
          <LoadingRow label="Disk kullanımı ölçülüyor" />
        </PanelBody>
      </Panel>
    );
  }

  // Ölçülemeyen domainler toplamın dışında; bunu saklamak toplamı olduğundan
  // küçük gösterip yanıltırdı.
  const unmeasured = usage.total_count - usage.measured_count;
  const ranked = [...usage.items]
    .filter((item) => typeof item.bytes === "number")
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const largest = ranked[0]?.bytes ?? 0;

  return (
    <Panel>
      <div className="sp-disk-summary">
        <div className="sp-disk-summary-head">
          <span className="sp-disk-summary-title">
            <CircleStackIcon aria-hidden="true" />
            Domainlerin disk kullanımı
          </span>
          <span className="sp-disk-summary-total sp-mono">
            toplam <strong>{formatBytes(usage.total_bytes)}</strong> · {usage.measured_count} domain
            {unmeasured > 0 && ` · ${unmeasured} tanesi ölçülemedi`}
          </span>
          <Button size="sm" variant="ghost" onClick={onRefresh} loading={loading} title="Yeniden ölç">
            <ArrowPathIcon aria-hidden="true" />
            Yenile
          </Button>
        </div>

        {ranked.length > 0 && (
          <ul className="sp-disk-list">
            {ranked.map((item) => (
              <li key={item.id} className="sp-disk-row">
                <span className="sp-disk-row-name">{item.domain_name}</span>
                <span className="sp-disk-row-track" aria-hidden="true">
                  <span
                    className="sp-disk-row-fill"
                    style={{ width: largest > 0 ? `${((item.bytes ?? 0) / largest) * 100}%` : "0%" }}
                  />
                </span>
                <span className="sp-disk-row-value sp-mono">{formatBytes(item.bytes ?? 0)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function DomainsView() {
  const { domains, domainsError, reloadDomains, user } = useShell();
  const isAdmin = user?.role === "admin";
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [dnsProvider, setDnsProvider] = useState<DnsProvider>("local");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Domain | null>(null);
  const [config, setConfig] = useState<{ domain: string; content: string } | null>(null);

  /*
    Disk kullanımı AYRI yüklenir.

    Sunucuda `du` dizini gerçekten geziyor (bu konteynerde 365 MB'lık bir
    domain ~1.7 sn). Domain listesine gömülseydi sayfa her açılışta o kadar
    beklerdi. Bu yüzden: liste anında gelir, kullanım arkadan dolar. Ölçüm
    başarısız olursa sayfa çalışmaya devam eder — disk satırı düşer, domain
    yönetimi etkilenmez.
  */
  const [diskUsage, setDiskUsage] = useState<DiskUsageResponse | null>(null);
  const [diskError, setDiskError] = useState<string | null>(null);
  const [diskLoading, setDiskLoading] = useState(false);

  const loadDiskUsage = useCallback(async (refresh = false) => {
    setDiskLoading(true);
    setDiskError(null);
    try {
      setDiskUsage(await api.domainsDiskUsage(refresh));
    } catch (err) {
      setDiskError(
        err instanceof ApiError ? err.message : "Disk kullanımı okunamadı.",
      );
    } finally {
      setDiskLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDiskUsage(false);
  }, [loadDiskUsage]);

  const usageById = new Map((diskUsage?.items ?? []).map((item) => [item.id, item]));

  async function addDomain(event: FormEvent) {
    event.preventDefault();
    const name = newDomain.trim();
    if (!name) return;
    setAdding(true);
    try {
      const result = await api.createDomain({ domain_name: name, dns_provider: dnsProvider });
      await reloadDomains();
      setNewDomain("");
      setAddOpen(false);
      toast.ok("Domain eklendi", `${name} dizini oluşturuldu.`);

      const deployment = result.dns_deployment;
      if (dnsProvider === "cloudflare") {
        if (deployment?.status === "ok") {
          toast.ok("DNS Cloudflare'e gönderildi", "Öneri kayıtları gerçek Cloudflare hesabına yazıldı.");
        } else if (deployment?.status === "zone_not_found") {
          toast.error("Cloudflare zone bulunamadı", "Kayıtlar panelde bekliyor — zone'u Cloudflare'de oluşturup elle gönderin.");
        } else if (deployment?.status === "not_configured") {
          toast.error("Cloudflare yapılandırılmadı", ".env.loopkit'e CLOUDFLARE_API_TOKEN ekleyin, sonra elle gönderin.");
        }
      } else if (dnsProvider === "local") {
        if (deployment?.applied) {
          toast.ok("Yerel DNS uygulandı", "BIND9 zone'u oluşturulup devreye alındı.");
        } else if (deployment?.apply_error) {
          toast.error("Yerel DNS uygulanamadı", deployment.apply_error);
        }
      }
    } catch (err) {
      toast.error(
        "Domain eklenemedi",
        err instanceof ApiError ? err.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setAdding(false);
    }
  }

  async function removeDomain(domain: Domain) {
    try {
      const result = await api.deleteDomain(domain.id, domain.domain_name);
      await reloadDomains();
      if (result.cleanup_status === "pending") {
        toast.info("Domain kaydı silindi", "Bazı dosyalar temizleme kuyruğuna alındı; operatör kaydı oluşturuldu.");
      } else {
        toast.ok("Domain silindi", `${result.domain_root_path} ve ona bağlı tüm kayıtlar kaldırıldı.`);
      }
    } catch (err) {
      toast.error("Domain silinemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    }
  }

  async function generateConfig(domain: Domain) {
    try {
      const result = await api.generateNginxConfig(domain.id);
      setConfig({ domain: domain.domain_name, content: result.content });
      await reloadDomains();
    } catch (err) {
      toast.error("Config üretilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    }
  }

  return (
    <>
      <PageHeader
        title="Domainler"
        breadcrumb="Web siteleri"
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <PlusIcon aria-hidden="true" />
              Domain ekle
            </Button>
          ) : undefined
        }
      />

      <div className="sp-stack">
        {domainsError && <Note tone="warn">{domainsError}</Note>}

        {domains === null ? (
          <Panel>
            <PanelBody flush>
              <LoadingRow label="Domainler yükleniyor" />
            </PanelBody>
          </Panel>
        ) : domains.length === 0 ? (
          <Panel>
            <PanelBody flush>
              <EmptyState
                icon={GlobeAltIcon}
                title="Henüz domain yok"
                text="İlk domaininizi ekleyin; dizin yapısı otomatik oluşturulur ve Nginx config'i tek tıkla üretilir."
                action={
                  isAdmin ? (
                    <Button variant="primary" onClick={() => setAddOpen(true)}>
                      <PlusIcon aria-hidden="true" />
                      Domain ekle
                    </Button>
                  ) : undefined
                }
              />
            </PanelBody>
          </Panel>
        ) : (
          <>
            <DiskUsageSummary
              usage={diskUsage}
              error={diskError}
              loading={diskLoading}
              onRefresh={() => void loadDiskUsage(true)}
            />
            {domains.map((domain) => (
              <DomainCard
                key={domain.id}
                domain={domain}
                diskUsage={usageById.get(domain.id)}
                onGenerateNginx={() => generateConfig(domain)}
                onDelete={isAdmin ? () => setDeleting(domain) : undefined}
                isAdmin={isAdmin}
              />
            ))}
          </>
        )}
      </div>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Domain ekle"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={adding}>
              Vazgeç
            </Button>
            <Button
              variant="primary"
              loading={adding}
              disabled={!newDomain.trim()}
              onClick={(event) => addDomain(event as unknown as FormEvent)}
            >
              Domain ekle
            </Button>
          </>
        }
      >
        <form onSubmit={addDomain}>
          <Field
            label="Domain adı"
            hint={
              <>
                Dizin <span className="sp-mono">/var/www/vhosts/{newDomain.trim() || "domain.com"}/public</span>{" "}
                olarak oluşturulur.
              </>
            }
          >
            <input
              className="sp-input sp-mono"
              placeholder="ornek.com"
              value={newDomain}
              onChange={(event) => setNewDomain(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="DNS yönetimi"
            hint="Öneri DNS kayıtları (A/CNAME/MX/SPF/DKIM/DMARC) oluşturulduktan hemen sonra otomatik olarak seçtiğiniz tarafa uygulanır."
          >
            <div className="sp-radio-group">
              {(
                [
                  { value: "local", label: "Kendi DNS'imiz (BIND9)", hint: "Bu sunucunun kendi otoriter DNS sunucusu — Cloudflare gerekmez." },
                  { value: "cloudflare", label: "Cloudflare", hint: "Gerçek Cloudflare hesabınıza yazılır — domain'in zone'u orada olmalı." },
                  { value: "none", label: "Şimdilik hiçbiri", hint: "Kayıtlar sadece panelde tutulur, elle karar verene kadar hiçbir yere uygulanmaz." },
                ] as const
              ).map((opt) => (
                <label key={opt.value} className="sp-radio-option">
                  <input
                    type="radio"
                    name="dns_provider"
                    value={opt.value}
                    checked={dnsProvider === opt.value}
                    onChange={() => setDnsProvider(opt.value)}
                  />
                  <span>
                    <strong>{opt.label}</strong>
                    <br />
                    <span className="sp-hint">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={async () => { if (deleting) await removeDomain(deleting); }}
        title="Domaini sil"
        confirmLabel="Domaini sil"
        confirmPhrase={deleting?.domain_name}
        description={
          <>
            Bu işlem <strong>{deleting?.domain_name}</strong> için şunları kalıcı olarak siler: veritabanı
            kaydı, <span className="sp-mono">{deleting ? deleting.directory_path.replace(/\/public$/, "") : ""}</span> dizini ve içindeki tüm
            dosyalar, DNS kayıtları, yedek arşivi ve üretilmiş Nginx config&apos;i. Geri alınamaz.
          </>
        }
      />

      <Modal
        open={config !== null}
        onClose={() => setConfig(null)}
        wide
        title={`${config?.domain} — Nginx config`}
        footer={
          <Button variant="secondary" onClick={() => setConfig(null)}>
            Kapat
          </Button>
        }
      >
        {config && <NginxConfigView domainName={config.domain} content={config.content} />}
      </Modal>
    </>
  );
}

export default function DomainsPage() {
  return (
    <AppShell>
      <DomainsView />
    </AppShell>
  );
}
