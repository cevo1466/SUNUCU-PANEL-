"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowPathIcon,
  CheckIcon,
  CloudIcon,
  PencilIcon,
  PlusIcon,
  ServerStackIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { api, ApiError, type CloudflareStatus, type DnsRecord } from "@/lib/api";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Field, LoadingRow, Note } from "@/components/ui/Bits";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

const RECORD_TYPES = ["A", "CNAME", "TXT", "MX", "SRV"] as const;

type Draft = {
  record_type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  weight?: number;
  port?: number;
  proxied?: boolean;
};

const EMPTY_DRAFT: Draft = { record_type: "A", name: "", content: "", ttl: 3600, proxied: false };

/** MX/SRV kayıtları priority (SRV ayrıca weight/port) gerektirir — sunucu tarafı da bunu zorunlu kılar. */
function needsPriority(recordType: string): boolean {
  return recordType === "MX" || recordType === "SRV";
}
/** Cloudflare proxy (turuncu bulut) yalnızca A/CNAME için anlamlıdır. */
function supportsProxy(recordType: string): boolean {
  return recordType === "A" || recordType === "CNAME";
}
function needsWeightPort(recordType: string): boolean {
  return recordType === "SRV";
}

function CloudflareBadge({ status }: { status: CloudflareStatus | null }) {
  if (!status) return null;
  if (status.status === "ok") {
    return (
      <Badge tone="ok">
        Cloudflare bağlı · {status.zone.name} ({status.liveRecordCount} canlı kayıt)
      </Badge>
    );
  }
  if (status.status === "zone_not_found") {
    return <Badge tone="warn">Cloudflare&apos;de zone yok — kayıtlar yalnızca panelde</Badge>;
  }
  if (status.status === "error") {
    return (
      <Badge tone="err">
        {status.reason === "permission" ? "Cloudflare izni yetersiz" : "Cloudflare'e ulaşılamıyor"}
      </Badge>
    );
  }
  return <Badge tone="neutral">Cloudflare yapılandırılmadı</Badge>;
}

/** Cloudflare sorunu için ne yapılacağını söyleyen açıklama. */
function CloudflareHelp({ status }: { status: CloudflareStatus | null }) {
  if (!status) return null;

  if (status.status === "not_configured") {
    return (
      <Note>
        Cloudflare token&apos;ı yapılandırılmadı. Kayıtlar yalnızca panel veritabanına yazılır, canlı
        DNS&apos;e gitmez. Bağlamak için sunucudaki <span className="sp-mono">.env.loopkit</span>{" "}
        dosyasına <span className="sp-mono">CLOUDFLARE_API_TOKEN</span> ekleyin ve API&apos;yi yeniden
        başlatın.
      </Note>
    );
  }

  if (status.status === "error" && status.reason === "permission") {
    return (
      <Note tone="warn">
        <strong>Cloudflare token&apos;ında DNS okuma izni yok.</strong> Token zone listesini
        okuyabiliyor ama DNS kayıtlarına erişemiyor (Cloudflare yanıtı:{" "}
        <span className="sp-mono">{status.message}</span>). Aşağıdaki kayıtlar panel veritabanından
        geliyor; Cloudflare ile senkron değiller.
        <br />
        Düzeltmek için: Cloudflare → My Profile → API Tokens → token&apos;ı düzenleyin →{" "}
        <span className="sp-mono">Zone → DNS → Read</span> iznini ekleyin (kayıt ekleyip silmek için{" "}
        <span className="sp-mono">Edit</span>). Zone Resources bu domaini kapsamalı.
      </Note>
    );
  }

  if (status.status === "error") {
    return (
      <Note tone="warn">
        Cloudflare&apos;e şu an ulaşılamıyor ({status.message}). Aşağıdaki kayıtlar panel
        veritabanından geliyor. Bağlantı düzeldiğinde &ldquo;Cloudflare&apos;den çek&rdquo; ile
        eşitleyebilirsiniz.
      </Note>
    );
  }

  if (status.status === "zone_not_found") {
    return (
      <Note>
        Cloudflare hesabında <span className="sp-mono">{status.domain}</span> adıyla eşleşen bir zone
        yok. Kayıtlar yalnızca panelde tutuluyor.
      </Note>
    );
  }

  return null;
}

/**
 * Cloudflare'den bağımsız: sunucunun kendi otoriter DNS'i (BIND). Yukarıdaki
 * tablodaki kayıtlardan bir zone dosyası üretir ve dar kapsamlı sudo ile
 * gerçek DNS sunucusuna uygulamayı dener — NginxPanel'deki
 * üret/uygula desenin birebir aynısı (bkz. apps/api/src/routes/dns.ts
 * local-apply, ops/scripts/deploy-zone.sh).
 */
function LocalDnsPanel({ domainId, onRecordAdded }: { domainId: number; onRecordAdded?: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<{
    zone_generated: boolean;
    zone_deployed: boolean;
    server_ip: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pointing, setPointing] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setStatus(await api.localDnsStatus(domainId));
    } catch {
      // Sessizce geç — üstteki Cloudflare/kayıt tablosu zaten ana bilgiyi taşıyor.
    }
  }, [domainId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pointToServer() {
    if (!status?.server_ip) return;
    setPointing(true);
    try {
      await api.createDnsRecord(domainId, {
        record_type: "A",
        name: "@",
        content: status.server_ip,
        ttl: 3600,
      });
      onRecordAdded?.();
      toast.ok("A kaydı eklendi", `@ → ${status.server_ip}`);
    } catch (err) {
      toast.error("Eklenemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setPointing(false);
    }
  }

  async function apply() {
    setBusy(true);
    try {
      const result = await api.applyLocalDns(domainId);
      setStatus((current) => ({
        zone_generated: true,
        zone_deployed: result.zone_deployed,
        server_ip: current?.server_ip ?? null,
      }));
      setWarnings(result.warnings);
      setLastError(result.apply_error);
      if (result.applied) {
        toast.ok("Sunucu DNS'ine uygulandı", "Zone dosyası BIND'e yüklendi.");
      } else {
        toast.error(
          "Zone üretildi, uygulanamadı",
          result.apply_error ?? "Sunucuda manuel deploy-zone.sh çalıştırılmalı.",
        );
      }
    } catch (err) {
      toast.error("Zone üretilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <PanelHead
        title={
          <>
            <ServerStackIcon aria-hidden="true" />
            Sunucu DNS&apos;i (yerel)
          </>
        }
        actions={
          <>
            <Badge tone={status?.zone_deployed ? "ok" : status?.zone_generated ? "info" : "neutral"}>
              {status?.zone_deployed ? "Uygulandı" : status?.zone_generated ? "Zone üretildi" : "Üretilmedi"}
            </Badge>
            {status?.server_ip && (
              <Button size="sm" variant="secondary" onClick={pointToServer} loading={pointing}>
                <PlusIcon aria-hidden="true" />
                Bu sunucuya yönlendir (A kaydı)
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={apply} loading={busy}>
              <ArrowPathIcon aria-hidden="true" />
              Zone oluştur ve uygula
            </Button>
          </>
        }
      />
      <PanelBody>
        <div className="sp-stack">
          <p className="sp-hint">
            Yukarıdaki kayıtlardan (Cloudflare&apos;e gidip gitmediğine bakılmaksızın hepsi) bu
            sunucunun kendi otoriter DNS sunucusu (BIND) için bir zone dosyası üretir ve uygular. Bu
            domain için ayrı bir nameserver işletiyorsanız kullanın; Cloudflare kullanıyorsanız
            gerekmez.
          </p>
          {!status?.server_ip && (
            <Note>
              &quot;Bu sunucuya yönlendir&quot; butonu için sunucudaki{" "}
              <span className="sp-mono">.env.loopkit</span> dosyasına{" "}
              <span className="sp-mono">SERVER_PUBLIC_IP=&lt;bu sunucunun genel IP&apos;si&gt;</span>{" "}
              ekleyip API&apos;yi yeniden başlatın. Panel bu IP&apos;yi otomatik keşfetmez — NAT/çoklu
              arayüz durumunda yanlış IP&apos;yi otomatik yazmak canlı bir domaini yanlış sunucuya
              yönlendirebileceğinden, bunu bilerek tek bir kez elle tanımlarsınız.
            </Note>
          )}
          {warnings.map((w) => (
            <Note key={w} tone="warn">
              {w}
            </Note>
          ))}
          {lastError && (
            <Note tone="warn">
              Otomatik uygulama başarısız: <span className="sp-mono">{lastError}</span>. Sunucuda{" "}
              <span className="sp-mono">sudo ops/scripts/deploy-zone.sh &lt;domain&gt;</span> çalıştırın.
            </Note>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
}

export function DnsManager({
  domainId,
  onCountChange,
}: {
  domainId: number;
  onCountChange?: (count: number) => void;
}) {
  const toast = useToast();
  const [records, setRecords] = useState<DnsRecord[] | null>(null);
  const [cfStatus, setCfStatus] = useState<CloudflareStatus | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [deleting, setDeleting] = useState<DnsRecord | null>(null);
  const [pushing, setPushing] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const load = useCallback(async () => {
    // allSettled, Promise.all değil: Cloudflare'e ulaşılamaması YEREL kayıtları
    // gizlememeli. Kayıtlar kendi veritabanımızda ve o sorgu her zaman çalışıyor.
    const [listResult, statusResult] = await Promise.allSettled([
      api.listDnsRecords(domainId),
      api.cloudflareStatus(domainId),
    ]);

    if (listResult.status === "fulfilled") {
      setRecords(listResult.value.records);
      onCountChange?.(listResult.value.records.length);
    } else {
      setRecords([]);
      const err = listResult.reason;
      toast.error(
        "DNS kayıtları alınamadı",
        err instanceof ApiError ? err.message : "Sunucuya ulaşılamadı.",
      );
    }

    if (statusResult.status === "fulfilled") {
      setCfStatus(statusResult.value);
    } else {
      // Uç artık izin hatalarında 200 dönüyor; buraya yalnızca gerçek bir
      // taşıma arızasında düşülür. Yerel kayıtlar yine ekranda kalır.
      const err = statusResult.reason;
      setCfStatus({
        status: "error",
        message: err instanceof ApiError ? err.message : "Cloudflare durumu okunamadı.",
        reason: "upstream",
      });
    }
  }, [domainId, onCountChange, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.createDnsRecord(domainId, draft);
      setDraft(EMPTY_DRAFT);
      await load();
      toast.ok(
        "DNS kaydı eklendi",
        result.cloudflareStatus === "synced"
          ? "Cloudflare'e de yazıldı."
          : "Yalnızca panele kaydedildi — Cloudflare zone'u bulunamadı.",
      );
    } catch (err) {
      toast.error("DNS kaydı eklenemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(recordId: number) {
    setBusy(true);
    try {
      await api.updateDnsRecord(domainId, recordId, editDraft);
      setEditingId(null);
      await load();
      toast.ok("DNS kaydı güncellendi");
    } catch (err) {
      toast.error("DNS kaydı güncellenemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(record: DnsRecord) {
    try {
      await api.deleteDnsRecord(domainId, record.id);
      await load();
      toast.ok("DNS kaydı silindi", `${record.record_type} ${record.name}`);
    } catch (err) {
      toast.error("DNS kaydı silinemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    }
  }

  async function pull() {
    setPulling(true);
    try {
      const result = await api.pullDnsFromCloudflare(domainId);
      await load();
      if (!result.configured) {
        toast.error(
          "Cloudflare yapılandırılmadı",
          "Sunucudaki .env.loopkit dosyasına CLOUDFLARE_API_TOKEN ekleyin.",
        );
      } else if (!result.zoneFound) {
        toast.error(
          "Zone bulunamadı",
          "Cloudflare hesabında bu domain adıyla eşleşen bir zone yok.",
        );
      } else {
        toast.ok("Cloudflare'den çekildi", `${result.pulled} kayıt güncellendi.`);
      }
    } catch (err) {
      toast.error("Cloudflare'den çekilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setPulling(false);
    }
  }

  const unsyncedCount = records?.filter((r) => !r.cloudflare_id).length ?? 0;

  async function pushToCloudflare() {
    setConfirmPush(false);
    setPushing(true);
    try {
      const result = await api.pushDnsToCloudflare(domainId);
      await load();
      if (result.status === "not_configured") {
        toast.error("Cloudflare yapılandırılmadı", "Sunucudaki .env.loopkit dosyasına CLOUDFLARE_API_TOKEN ekleyin.");
      } else if (result.status === "zone_not_found") {
        toast.error("Zone bulunamadı", "Cloudflare hesabında bu domain adıyla eşleşen bir zone yok.");
      } else {
        const ok = result.results.filter((r) => r.ok).length;
        const failed = result.results.length - ok;
        if (failed === 0) {
          toast.ok("Cloudflare'e gönderildi", `${ok} kayıt oluşturuldu.`);
        } else {
          toast.error("Bazı kayıtlar gönderilemedi", `${ok} başarılı, ${failed} başarısız.`);
        }
      }
    } catch (err) {
      toast.error("Cloudflare'e gönderilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setPushing(false);
    }
  }

  // Cloudflare kullanmaktan tamamen vazgeçmek isteyenler için: SADECE panelin
  // yerel dns_records tablosunu temizler, Cloudflare'deki hiçbir kayda
  // dokunmaz (bkz. routes/dns.ts — tek yönlü, yerel -> hicbir yere).
  async function deleteAll() {
    setConfirmDeleteAll(false);
    setDeletingAll(true);
    try {
      const result = await api.deleteAllDnsRecords(domainId);
      await load();
      toast.ok("Tüm yerel DNS kayıtları silindi", `${result.deletedCount} kayıt kaldırıldı — Cloudflare'e dokunulmadı.`);
    } catch (err) {
      toast.error("Kayıtlar silinemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setDeletingAll(false);
    }
  }

  return (
    <>
      <Panel>
        <PanelHead
          title={
            <>
              <CloudIcon aria-hidden="true" />
              DNS kayıtları
            </>
          }
          actions={
            <>
              <CloudflareBadge status={cfStatus} />
              {unsyncedCount > 0 && (
                <Button size="sm" variant="secondary" onClick={() => setConfirmPush(true)} loading={pushing}>
                  <CloudIcon aria-hidden="true" />
                  Cloudflare&apos;e Gönder ({unsyncedCount})
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={pull} loading={pulling}>
                <ArrowPathIcon aria-hidden="true" />
                Cloudflare&apos;den çek
              </Button>
              {records && records.length > 0 && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setConfirmDeleteAll(true)}
                  loading={deletingAll}
                  title="Sadece panelden siler, Cloudflare'e dokunmaz"
                >
                  <TrashIcon aria-hidden="true" />
                  Tüm Kayıtları Sil (sadece panel)
                </Button>
              )}
            </>
          }
        />

        {cfStatus && cfStatus.status !== "ok" && (
          <div style={{ padding: "12px 14px 0" }}>
            <CloudflareHelp status={cfStatus} />
          </div>
        )}

        <PanelBody flush>
          {records === null ? (
            <LoadingRow label="DNS kayıtları okunuyor" />
          ) : records.length === 0 ? (
            <EmptyState
              icon={CloudIcon}
              title="Henüz DNS kaydı yok"
              text="Aşağıdaki formdan ilk kaydı ekleyin. Cloudflare bağlıysa kayıt oraya da yazılır."
            />
          ) : (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Tip</th>
                    <th>Ad</th>
                    <th>İçerik</th>
                    <th className="sp-num" style={{ width: 80 }}>
                      TTL
                    </th>
                    <th style={{ width: 90 }}>Durum</th>
                    <th className="sp-cell-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) =>
                    editingId === record.id ? (
                      <tr key={record.id}>
                        <td>
                          <select
                            className="sp-select"
                            value={editDraft.record_type}
                            onChange={(e) => setEditDraft({ ...editDraft, record_type: e.target.value })}
                            aria-label="Kayıt tipi"
                          >
                            {RECORD_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {type}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="sp-input sp-mono"
                            value={editDraft.name}
                            onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                            aria-label="Kayıt adı"
                          />
                        </td>
                        <td>
                          <input
                            className="sp-input sp-mono"
                            value={editDraft.content}
                            onChange={(e) => setEditDraft({ ...editDraft, content: e.target.value })}
                            aria-label="Kayıt içeriği"
                          />
                          {needsPriority(editDraft.record_type) && (
                            <div className="sp-row" style={{ gap: 4, marginTop: 4 }}>
                              <input
                                className="sp-input sp-mono"
                                style={{ width: 64 }}
                                type="number"
                                placeholder="priority"
                                value={editDraft.priority ?? ""}
                                onChange={(e) => setEditDraft({ ...editDraft, priority: Number(e.target.value) })}
                                aria-label="Priority"
                              />
                              {needsWeightPort(editDraft.record_type) && (
                                <>
                                  <input
                                    className="sp-input sp-mono"
                                    style={{ width: 64 }}
                                    type="number"
                                    placeholder="weight"
                                    value={editDraft.weight ?? ""}
                                    onChange={(e) => setEditDraft({ ...editDraft, weight: Number(e.target.value) })}
                                    aria-label="Weight"
                                  />
                                  <input
                                    className="sp-input sp-mono"
                                    style={{ width: 64 }}
                                    type="number"
                                    placeholder="port"
                                    value={editDraft.port ?? ""}
                                    onChange={(e) => setEditDraft({ ...editDraft, port: Number(e.target.value) })}
                                    aria-label="Port"
                                  />
                                </>
                              )}
                            </div>
                          )}
                          {supportsProxy(editDraft.record_type) && (
                            <label className="sp-row" style={{ gap: 4, marginTop: 4, alignItems: "center" }}>
                              <input
                                type="checkbox"
                                checked={editDraft.proxied ?? false}
                                onChange={(e) => setEditDraft({ ...editDraft, proxied: e.target.checked })}
                                aria-label="Cloudflare proxy"
                              />
                              <span className="sp-hint">☁️ Proxy</span>
                            </label>
                          )}
                        </td>
                        <td>
                          <input
                            className="sp-input sp-mono"
                            type="number"
                            min={60}
                            max={86400}
                            value={editDraft.ttl}
                            onChange={(e) => setEditDraft({ ...editDraft, ttl: Number(e.target.value) })}
                            aria-label="TTL"
                          />
                        </td>
                        <td />
                        <td className="sp-cell-actions">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => saveEdit(record.id)}
                            disabled={busy}
                            aria-label="Değişikliği kaydet"
                          >
                            <CheckIcon aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingId(null)}
                            aria-label="Düzenlemeden vazgeç"
                          >
                            <XMarkIcon aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={record.id}>
                        <td>
                          <Badge tone="neutral">{record.record_type}</Badge>
                        </td>
                        <td className="sp-mono">{record.name}</td>
                        <td className="sp-mono" style={{ color: "var(--sp-ink-muted)", overflowWrap: "anywhere" }}>
                          {record.record_type === "SRV"
                            ? `${record.priority ?? 0} ${record.weight ?? 0} ${record.port ?? 0} ${record.content}`
                            : record.record_type === "MX"
                              ? `${record.priority ?? 0} ${record.content}`
                              : record.content}
                          {supportsProxy(record.record_type) && record.proxied && " ☁️"}
                        </td>
                        <td className="sp-num sp-mono" style={{ color: "var(--sp-ink-muted)" }}>
                          {record.ttl}
                        </td>
                        <td>
                          {record.cloudflare_id ? (
                            <Badge tone="ok">Senkron</Badge>
                          ) : (
                            <Badge tone="neutral">Gönderilmedi</Badge>
                          )}
                        </td>
                        <td className="sp-cell-actions">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${record.name} kaydını düzenle`}
                            onClick={() => {
                              setEditingId(record.id);
                              setEditDraft({
                                record_type: record.record_type,
                                name: record.name,
                                content: record.content,
                                ttl: record.ttl,
                                priority: record.priority ?? undefined,
                                weight: record.weight ?? undefined,
                                port: record.port ?? undefined,
                                proxied: record.proxied,
                              });
                            }}
                          >
                            <PencilIcon aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${record.name} kaydını sil`}
                            onClick={() => setDeleting(record)}
                          >
                            <TrashIcon aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </PanelBody>

        <div style={{ borderTop: "1px solid var(--sp-line)", padding: 14 }}>
          <form onSubmit={create} className="sp-row" style={{ alignItems: "flex-end", gap: 8 }}>
            <Field label="Tip" className="sp-field" >
              <select
                className="sp-select"
                style={{ width: 90 }}
                value={draft.record_type}
                onChange={(e) => setDraft({ ...draft, record_type: e.target.value })}
              >
                {RECORD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ad" className="sp-field" >
              <input
                className="sp-input sp-mono"
                style={{ minWidth: 140 }}
                required
                placeholder="www"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="İçerik" className="sp-field" >
              <input
                className="sp-input sp-mono"
                style={{ minWidth: 180 }}
                required
                placeholder="203.0.113.10"
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              />
            </Field>
            {needsPriority(draft.record_type) && (
              <Field label="Priority" className="sp-field">
                <input
                  className="sp-input sp-mono"
                  style={{ width: 70 }}
                  type="number"
                  required
                  value={draft.priority ?? ""}
                  onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                />
              </Field>
            )}
            {needsWeightPort(draft.record_type) && (
              <>
                <Field label="Weight" className="sp-field">
                  <input
                    className="sp-input sp-mono"
                    style={{ width: 70 }}
                    type="number"
                    required
                    value={draft.weight ?? ""}
                    onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Port" className="sp-field">
                  <input
                    className="sp-input sp-mono"
                    style={{ width: 70 }}
                    type="number"
                    required
                    value={draft.port ?? ""}
                    onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
                  />
                </Field>
              </>
            )}
            {supportsProxy(draft.record_type) && (
              <Field label="Proxy" className="sp-field">
                <label className="sp-row" style={{ gap: 4, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={draft.proxied ?? false}
                    onChange={(e) => setDraft({ ...draft, proxied: e.target.checked })}
                  />
                  <span className="sp-hint">☁️ Turuncu bulut</span>
                </label>
              </Field>
            )}
            <Field label="TTL" className="sp-field">
              <input
                className="sp-input sp-mono"
                style={{ width: 90 }}
                type="number"
                min={60}
                max={86400}
                value={draft.ttl}
                onChange={(e) => setDraft({ ...draft, ttl: Number(e.target.value) })}
              />
            </Field>
            <Button type="submit" variant="primary" loading={busy}>
              <PlusIcon aria-hidden="true" />
              Kayıt ekle
            </Button>
          </form>

        </div>
      </Panel>

      <LocalDnsPanel domainId={domainId} onRecordAdded={load} />

      <ConfirmDialog
        open={confirmPush}
        onClose={() => setConfirmPush(false)}
        onConfirm={pushToCloudflare}
        title="DNS kayıtlarını Cloudflare'e gönder"
        description={
          <>
            <strong>{unsyncedCount}</strong> kayıt gerçek Cloudflare hesabına yazılacak — bu, canlı DNS&apos;i
            etkiler. Devam edilsin mi?
          </>
        }
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={async () => { if (deleting) await remove(deleting); }}
        title="DNS kaydını sil"
        description={
          <>
            <strong className="sp-mono">
              {deleting?.record_type} {deleting?.name} → {deleting?.content}
            </strong>{" "}
            silinecek.
            {deleting?.cloudflare_id
              ? " Bu kayıt daha önce Cloudflare'den çekilmişti ama silme SADECE panelden yapılır — Cloudflare'deki gerçek kayda dokunulmaz."
              : " Kayıt yalnızca panelde tutuluyor."}
          </>
        }
      />

      <ConfirmDialog
        open={confirmDeleteAll}
        onClose={() => setConfirmDeleteAll(false)}
        onConfirm={deleteAll}
        title="Tüm yerel DNS kayıtlarını sil"
        destructive
        description={
          <>
            Bu domain için panelde kayıtlı <strong>{records?.length ?? 0}</strong> DNS kaydının tamamı
            silinecek. Bu işlem <strong>SADECE panelin kendi veritabanını</strong> temizler — Cloudflare&apos;deki
            hiçbir kayda dokunulmaz. Cloudflare kullanmaktan tamamen vazgeçtiğinizde panel tarafını
            sıfırlamak için kullanın.
          </>
        }
      />
    </>
  );
}
