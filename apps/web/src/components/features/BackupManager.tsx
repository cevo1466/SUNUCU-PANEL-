"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArchiveBoxIcon,
  ArrowDownTrayIcon,
  ArrowUturnLeftIcon,
  CheckBadgeIcon,
  CircleStackIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { api, ApiError, type BackupVersion, type RestorePlan } from "@/lib/api";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/useElapsedSeconds";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState, LoadingRow, Note } from "@/components/ui/Bits";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

/**
 * Yedek sürümleri.
 *
 * TASARIMIN MERKEZİ FİKRİ — DOĞRULAMA DURUMU. Bir yedek "var" olması yüzünden
 * değil, GERİ YÜKLENEBİLDİĞİ KANITLANDIĞI için güven verir. Bu yüzden her
 * satırın en görünür işareti doğrulama rozetidir ve hiç denenmemiş bir yedek
 * asla yeşil gösterilmez — "doğrulanmadı" der. Panelin başka yerlerindeki
 * dürüstlük kuralının aynısı (mail servisi "kurulu değil" der, uydurmaz).
 */
function VerifyBadge({ backup }: { backup: BackupVersion }) {
  if (backup.verify_status === "ok") {
    return (
      <span className="sp-verify" data-state="ok" title={`Doğrulandı: ${formatDateTime(backup.verified_at!)}`}>
        <ShieldCheckIcon aria-hidden="true" />
        geri yüklenebilir
      </span>
    );
  }
  if (backup.verify_status === "failed") {
    return (
      <span className="sp-verify" data-state="err" title={backup.verify_error ?? undefined}>
        <ExclamationTriangleIcon aria-hidden="true" />
        DOĞRULAMA BAŞARISIZ
      </span>
    );
  }
  return (
    <span className="sp-verify" data-state="unknown" title="Bu yedek henüz geri yükleme testinden geçmedi.">
      doğrulanmadı
    </span>
  );
}

export function BackupManager({
  domainId,
  domainName,
  onChange,
}: {
  domainId: number;
  domainName: string;
  onChange?: (latest: BackupVersion | null) => void;
}) {
  const toast = useToast();
  const [backups, setBackups] = useState<BackupVersion[] | null>(null);
  const [retention, setRetention] = useState(7);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const creatingElapsed = useElapsedSeconds(creating);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BackupVersion | null>(null);
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoreDbs, setRestoreDbs] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listBackups(domainId);
      setBackups(data.backups);
      setRetention(data.retention);
      onChange?.(data.backups[0] ?? null);
    } catch (err) {
      toast.error("Yedekler okunamadı", err instanceof ApiError ? err.message : "Sunucuya ulaşılamadı.");
    } finally {
      setLoading(false);
    }
    // onChange kasıtlı olarak bağımlılıkta değil: üst bileşen her render'da
    // yeni bir fonksiyon veriyor ve bu sonsuz döngü yapardı.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    try {
      const result = await api.createBackup(domainId);
      if (result.complete) {
        toast.ok("Yedek alındı", `${result.name} · ${formatBytes(result.size_bytes)}`);
      } else {
        // Eksik parça SESSİZ GEÇMEZ: yedek alındı ama tam değil.
        toast.error("Yedek EKSİK alındı", result.warnings.join(" · "));
      }
      await load();
    } catch (err) {
      toast.error("Yedek alınamadı", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setCreating(false);
    }
  }

  async function verify(name: string) {
    setVerifying(name);
    try {
      const result = await api.verifyBackup(domainId, name);
      if (result.ok) {
        toast.ok(
          "Doğrulandı",
          `Arşiv açıldı, ${result.detail.parts_checked} parça sağlam, ` +
            `${result.detail.databases_loaded.length} veritabanı gerçekten yüklendi.`,
        );
      } else {
        toast.error("Doğrulama başarısız", result.error ?? "Bu yedek geri yüklenemeyebilir.");
      }
      await load();
    } catch (err) {
      toast.error("Doğrulanamadı", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setVerifying(null);
    }
  }

  async function openRestore(backup: BackupVersion) {
    try {
      setRestorePlan(await api.restorePlan(domainId, backup.name));
      setRestoreConfirm("");
      setRestoreDbs(false);
    } catch (err) {
      toast.error("Geri yükleme planı alınamadı", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    }
  }

  async function doRestore() {
    if (!restorePlan) return;
    setRestoring(true);
    try {
      const result = await api.restoreBackup(domainId, restorePlan.archive, restoreConfirm, restoreDbs);
      const dbNote = result.databases_failed.length
        ? ` ${result.databases_failed.length} veritabanı geri yüklenemedi.`
        : "";
      toast.ok("Geri yüklendi", `Eski hâl ${result.quarantine_dir} altına alındı.${dbNote}`);
      setRestorePlan(null);
      await load();
    } catch (err) {
      toast.error("Geri yüklenemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setRestoring(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await api.deleteBackup(domainId, deleting.name);
      toast.ok("Yedek silindi", deleting.name);
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error("Silinemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    }
  }

  return (
    <>
      <Panel>
        <PanelHead
          title={
            <>
              <ArchiveBoxIcon aria-hidden="true" />
              Yedekler
            </>
          }
          note={`son ${retention} sürüm tutulur · doğrulanmış yedek asla silinmez`}
          actions={
            <Button variant="primary" size="sm" onClick={create} loading={creating}>
              {creating
                ? creatingElapsed < 10
                  ? "Alınıyor…"
                  : `Alınıyor… ${formatDuration(creatingElapsed)} (büyük sitelerde dakikalar sürebilir)`
                : "Yedek al"}
            </Button>
          }
        />
        <PanelBody flush>
          {loading ? (
            <LoadingRow label="Yedekler okunuyor" />
          ) : !backups || backups.length === 0 ? (
            <EmptyState
              icon={ArchiveBoxIcon}
              title="Henüz yedek yok"
              text="Yedek alın: dosyalar, veritabanları, nginx yapılandırması, DNS kayıtları ve DKIM anahtarı tek arşivde toplanır."
            />
          ) : (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Boyut</th>
                    <th>İçerik</th>
                    <th>Doğrulama</th>
                    <th aria-label="İşlemler" />
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.name}>
                      <td>
                        {formatDateTime(b.created_at)}
                        {b.complete === false && (
                          <span className="sp-verify" data-state="err" title={b.warnings.join(" · ")}>
                            EKSİK
                          </span>
                        )}
                      </td>
                      <td className="sp-mono">{formatBytes(b.size_bytes)}</td>
                      <td className="sp-backup-content">
                        {b.file_count !== null && <span>{b.file_count.toLocaleString("tr")} dosya</span>}
                        {b.databases.map((d) => (
                          <span key={d.name} className="sp-backup-db" title={`${d.engine} veritabanı`}>
                            <CircleStackIcon aria-hidden="true" />
                            {d.name}
                          </span>
                        ))}
                      </td>
                      <td>
                        <VerifyBadge backup={b} />
                      </td>
                      <td className="sp-row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void verify(b.name)}
                          loading={verifying === b.name}
                          title="Bu yedeği gerçekten geri yükleyerek test et"
                        >
                          <CheckBadgeIcon aria-hidden="true" />
                          Doğrula
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void openRestore(b)}
                          title="Bu yedeğe geri dön"
                        >
                          <ArrowUturnLeftIcon aria-hidden="true" />
                          Geri yükle
                        </Button>
                        <ButtonLink size="sm" variant="ghost" href={api.backupDownloadUrl(domainId, b.name)}>
                          <ArrowDownTrayIcon aria-hidden="true" />
                          İndir
                        </ButtonLink>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(b)} title="Sil">
                          <TrashIcon aria-hidden="true" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PanelBody>
      </Panel>

      {/* Geri yükleme: ÖNCE ne olacağını göster, sonra onay iste. */}
      <Modal
        open={Boolean(restorePlan)}
        onClose={() => setRestorePlan(null)}
        title="Geri yükle"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRestorePlan(null)} disabled={restoring}>
              Vazgeç
            </Button>
            <Button
              variant="danger"
              loading={restoring}
              disabled={restoreConfirm !== domainName}
              onClick={doRestore}
            >
              Geri yükle
            </Button>
          </>
        }
      >
        {restorePlan && (
          <div className="sp-stack">
            <Note tone="warn">
              <strong>{restorePlan.target_dir}</strong> dizininin şu anki içeriği bu yedekle
              değiştirilecek. Eski hâl silinmez — karantinaya alınır, gerekirse geri dönebilirsiniz.
            </Note>

            <dl className="sp-kv">
              <dt>Yedek</dt>
              <dd className="sp-mono">
                {restorePlan.archive} · {formatDateTime(restorePlan.created_at)}
              </dd>
              <dt>Dosya</dt>
              <dd>
                yedekte {restorePlan.file_count.toLocaleString("tr")}
                {restorePlan.current_file_count !== null &&
                  ` · şu an diskte ${restorePlan.current_file_count.toLocaleString("tr")}`}
              </dd>
              <dt>Yedekteki ekler</dt>
              <dd>{restorePlan.parts.map((p) => p.note).join(", ") || "yok"}</dd>
            </dl>

            {restorePlan.warnings.length > 0 && (
              <Note tone="warn">Bu yedek eksik: {restorePlan.warnings.join(" · ")}</Note>
            )}

            {restorePlan.databases.length > 0 && (
              <label className="sp-check">
                <input
                  type="checkbox"
                  checked={restoreDbs}
                  onChange={(e) => setRestoreDbs(e.target.checked)}
                />
                <span>
                  Veritabanlarını da geri yükle ({restorePlan.databases.map((d) => d.name).join(", ")}) —{" "}
                  <strong>bu, canlı veriyi yedekteki hâline geri sarar.</strong>
                </span>
              </label>
            )}

            <label className="wm-field">
              <span>
                Onaylamak için domain adını yazın: <strong>{domainName}</strong>
              </span>
              <input
                className="sp-input sp-mono"
                value={restoreConfirm}
                onChange={(e) => setRestoreConfirm(e.target.value)}
                placeholder={domainName}
                autoComplete="off"
              />
            </label>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Yedeği sil"
        description={
          deleting
            ? `${formatDateTime(deleting.created_at)} tarihli yedek (${formatBytes(deleting.size_bytes)}) kalıcı olarak silinecek.`
            : ""
        }
        confirmLabel="Sil"
        destructive
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}
