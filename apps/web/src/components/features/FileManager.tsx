"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  ArchiveBoxArrowDownIcon,
  ArrowUpIcon,
  ArrowUpTrayIcon,
  DocumentIcon,
  DocumentPlusIcon,
  FolderArrowDownIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PencilIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { api, ApiError, type FileEntry, type UploadItem } from "@/lib/api";
import {
  chunkUploads,
  isArchiveName,
  itemsFromDataTransfer,
  itemsFromFileList,
  overallUploadedBytes,
} from "@/lib/upload";
import { formatBytes, formatBytesPerSecond, formatDateTime, formatDuration } from "@/lib/format";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState, Field, LoadingRow } from "@/components/ui/Bits";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function parentPath(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

type Dialog =
  | { kind: "new-folder" }
  | { kind: "new-file" }
  | { kind: "rename"; entry: FileEntry }
  | null;

/** Silme onayı: tek girdi ya da çoklu seçim. */
type Deletion =
  | { kind: "single"; entry: FileEntry }
  | { kind: "bulk"; names: string[] }
  | null;

/**
 * Yükleme ilerlemesi.
 *
 * Eskiden yalnızca DOSYA ADEDİ tutuluyordu ("3/10") ve bu tek büyük dosyada
 * hiçbir şey göstermiyordu: 500 MB'lık bir dosya için sayaç yükleme boyunca
 * "0/1"de kalıp sonunda "1/1" oluyordu. İlerleme artık BAYT üzerinden
 * izleniyor; yüzde, hız ve kalan süre buradan geliyor.
 */
interface UploadProgress {
  /** Bugüne kadar gönderilen toplam bayt (biten paketler + süren paket). */
  loadedBytes: number;
  /** Yüklemenin tamamının bayt cinsinden boyutu. */
  totalBytes: number;
  /** Tamamlanan dosya sayısı — "142/300 dosya" satırı için. */
  doneFiles: number;
  totalFiles: number;
  /** Ölçülen anlık hız. Henüz ölçülemediyse null. */
  bytesPerSecond: number | null;
  /** Tahmini kalan süre (saniye). Hız bilinmiyorsa null. */
  etaSeconds: number | null;
}

/**
 * Anlık hızı yumuşatan ölçer.
 *
 * Ham "son iki olay arası" hız çok gürültülü: tarayıcı ilerlemeyi düzensiz
 * aralıklarla bildiriyor ve sayı saniyede birkaç kez zıplayıp okunmaz hale
 * geliyordu. Burada son ~5 saniyelik pencereye bakılıyor — sayı sakin kalıyor
 * ama gerçek bir yavaşlamayı da birkaç saniyede yansıtıyor.
 */
class SpeedMeter {
  private samples: Array<{ at: number; loaded: number }> = [];
  private static readonly WINDOW_MS = 5000;

  push(loaded: number): void {
    const now = Date.now();
    this.samples.push({ at: now, loaded });
    while (this.samples.length > 2 && now - this.samples[0].at > SpeedMeter.WINDOW_MS) {
      this.samples.shift();
    }
  }

  /** Bayt/saniye. Anlamlı bir ölçüm yoksa null — uydurma değer verilmez. */
  rate(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsedMs = last.at - first.at;
    const deltaBytes = last.loaded - first.loaded;
    if (elapsedMs < 500 || deltaBytes <= 0) return null;
    return (deltaBytes / elapsedMs) * 1000;
  }
}

/**
 * Yükleme ilerleme şeridi.
 *
 * Kullanıcının sorduğu üç şeyi aynı anda cevaplar: ne kadarı gitti (yüzde ve
 * çubuk), ne hızla gidiyor, daha ne kadar bekleyeceğim. Ayrıca vazgeçme yolu
 * verir — büyük bir dosyayı yanlışlıkla başlatan kullanıcının tek çaresi
 * sekmeyi kapatmak olmasın.
 *
 * `aria-live="polite"`: ekran okuyucu yüzdeyi her değişimde okumaz ama
 * kullanıcı odaklandığında güncel durumu duyar. `role="progressbar"` ile
 * değerler yardımcı teknolojiye sayı olarak da veriliyor.
 */
function UploadProgressBar({
  progress,
  onCancel,
}: {
  progress: UploadProgress;
  onCancel: () => void;
}) {
  const { loadedBytes, totalBytes, doneFiles, totalFiles, bytesPerSecond, etaSeconds } = progress;
  const percent = totalBytes > 0 ? Math.min(100, (loadedBytes / totalBytes) * 100) : 0;
  const percentLabel = `%${percent.toFixed(percent >= 10 ? 0 : 1).replace(".", ",")}`;

  return (
    <div className="sp-upload-progress" aria-live="polite">
      <div className="sp-upload-progress-top">
        <span className="sp-upload-progress-title">
          Yükleniyor · <strong>{percentLabel}</strong>
        </span>
        <span className="sp-upload-progress-stats sp-mono">
          {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
          {totalFiles > 1 && ` · ${doneFiles}/${totalFiles} dosya`}
          {bytesPerSecond !== null && ` · ${formatBytesPerSecond(bytesPerSecond)}`}
          {etaSeconds !== null && ` · ~${formatDuration(etaSeconds)} kaldı`}
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          İptal
        </Button>
      </div>
      <div
        className="sp-upload-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={`${percentLabel} yüklendi`}
        aria-label="Yükleme ilerlemesi"
      >
        <div className="sp-upload-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function FileManager({ domainId, rootLabel }: { domainId: number; rootLabel: string }) {
  const toast = useToast();
  const [path, setPath] = useState("public");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [deleting, setDeleting] = useState<Deletion>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  // Süren yüklemeyi gerçekten kesebilmek için: iptal, XHR'ı abort eder.
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [extracting, setExtracting] = useState<FileEntry | null>(null);
  const [extractBusy, setExtractBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (target: string) => {
      setEntries(null);
      try {
        const result = await api.listFiles(domainId, target);
        setEntries(result.entries);
      } catch (err) {
        setEntries([]);
        toast.error(
          "Dizin listelenemedi",
          err instanceof ApiError ? err.message : "Sunucuya ulaşılamadı.",
        );
      }
    },
    [domainId, toast],
  );

  useEffect(() => {
    void load(path);
  }, [load, path]);

  // Klasör değişince eski seçim anlamsız kalır.
  useEffect(() => {
    setSelected([]);
  }, [path]);

  // Listeden kalkmış adlar seçili kalmasın (silme/yeniden adlandırma sonrası).
  useEffect(() => {
    if (!entries) return;
    setSelected((current) => {
      const alive = current.filter((name) => entries.some((entry) => entry.name === name));
      return alive.length === current.length ? current : alive;
    });
  }, [entries]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = entries !== null && entries.length > 0 && selected.length === entries.length;

  async function openEntry(entry: FileEntry) {
    const full = joinPath(path, entry.name);
    if (entry.type === "directory") {
      setPath(full);
      return;
    }
    try {
      const result = await api.readFile(domainId, full);
      setEditing({ path: full, content: result.content });
    } catch (err) {
      toast.error(
        "Dosya açılamadı",
        err instanceof ApiError ? err.message : "Dosya okunamadı.",
      );
    }
  }

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog) return;
    const name = dialogValue.trim();
    if (!name) return;

    setDialogBusy(true);
    try {
      if (dialog.kind === "rename") {
        await api.renameFile(domainId, joinPath(path, dialog.entry.name), joinPath(path, name));
        toast.ok("Yeniden adlandırıldı", `${dialog.entry.name} → ${name}`);
      } else {
        await api.createFile(domainId, joinPath(path, name), dialog.kind === "new-folder");
        toast.ok(dialog.kind === "new-folder" ? "Klasör oluşturuldu" : "Dosya oluşturuldu", name);
      }
      setDialog(null);
      await load(path);
    } catch (err) {
      toast.error(
        dialog.kind === "rename" ? "Yeniden adlandırılamadı" : "Oluşturulamadı",
        err instanceof ApiError ? err.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setDialogBusy(false);
    }
  }

  async function remove(entry: FileEntry) {
    try {
      await api.deleteFile(domainId, joinPath(path, entry.name));
      toast.ok("Kalıcı olarak silindi", entry.name);
      await load(path);
    } catch (err) {
      toast.error("Silinemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    }
  }

  /** Seçili girdileri tek istekte kalıcı siler; başarısızları ayrıca bildirir. */
  async function removeMany(names: string[]) {
    try {
      const result = await api.bulkDeleteFiles(
        domainId,
        names.map((name) => joinPath(path, name)),
      );
      if (result.failed.length === 0) {
        toast.ok("Kalıcı olarak silindi", `${result.deleted.length} öğe silindi.`);
      } else {
        toast.error(
          `${result.deleted.length} silindi, ${result.failed.length} silinemedi`,
          result.failed.map((item) => `${item.path}: ${item.error}`).join(" · "),
        );
      }
      setSelected([]);
      await load(path);
    } catch (err) {
      toast.error("Silinemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    }
  }

  /**
   * Yükleme. Klasör ağacı korunur ve istek Nginx gövde sınırını aşmasın diye
   * parçalara bölünüp sırayla gönderilir.
   */
  async function uploadItems(items: UploadItem[]) {
    if (items.length === 0) {
      toast.error("Yüklenecek dosya yok", "Seçilen klasör boş görünüyor.");
      return;
    }
    const batches = chunkUploads(items);
    const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const meter = new SpeedMeter();

    setUploading(true);
    setUploadProgress({
      loadedBytes: 0,
      totalBytes,
      doneFiles: 0,
      totalFiles: items.length,
      bytesPerSecond: null,
      etaSeconds: null,
    });

    let uploaded = 0;
    // Biten paketlerin baytı. Süren paketin ilerlemesi bunun ÜSTÜNE eklenir;
    // aksi halde her yeni pakette çubuk sıfıra düşerdi.
    let completedBytes = 0;

    try {
      for (const batch of batches) {
        const batchBytes = batch.reduce((sum, item) => sum + item.file.size, 0);

        await api.uploadFiles(domainId, path, batch, {
          signal: controller.signal,
          // loaded/total GÖVDE baytıdır (multipart zarfı dahil), dosya baytı
          // DEĞİL. Dönüşümü overallUploadedBytes yapar — gerekçesi orada.
          onProgress: (loaded, total) => {
            const overall = overallUploadedBytes({
              completedFileBytes: completedBytes,
              batchFileBytes: batchBytes,
              batchLoaded: loaded,
              batchTotal: total,
              totalFileBytes: totalBytes,
            });
            meter.push(overall);
            const rate = meter.rate();
            setUploadProgress({
              loadedBytes: overall,
              totalBytes,
              doneFiles: uploaded,
              totalFiles: items.length,
              bytesPerSecond: rate,
              etaSeconds: rate ? Math.max(0, (totalBytes - overall) / rate) : null,
            });
          },
        });

        uploaded += batch.length;
        completedBytes += batchBytes;
        setUploadProgress((previous) => ({
          loadedBytes: completedBytes,
          totalBytes,
          doneFiles: uploaded,
          totalFiles: items.length,
          bytesPerSecond: previous?.bytesPerSecond ?? null,
          etaSeconds: previous?.etaSeconds ?? null,
        }));
      }
      toast.ok(
        "Yüklendi",
        items.length === 1
          ? items[0].relPath
          : `${uploaded} dosya yüklendi (klasör yapısı korundu).`,
      );
    } catch (err) {
      // İptal kullanıcının kendi kararı; hata gibi kırmızı gösterilmez.
      const aborted =
        err instanceof ApiError && (err.body as { aborted?: boolean } | null)?.aborted === true;
      if (aborted) {
        toast.ok(
          "Yükleme iptal edildi",
          uploaded > 0
            ? `${uploaded} dosya yüklenmişti, kalanı gönderilmedi.`
            : "Hiçbir dosya yüklenmedi.",
        );
      } else {
        toast.error(
          uploaded > 0 ? `Yükleme yarıda kaldı (${uploaded}/${items.length})` : "Yüklenemedi",
          err instanceof ApiError ? err.message : "İşlem tamamlanmadı.",
        );
      }
    } finally {
      uploadAbortRef.current = null;
      setUploading(false);
      setUploadProgress(null);
      await load(path);
    }
  }

  function cancelUpload() {
    uploadAbortRef.current?.abort();
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    setUploading(true);
    let items: UploadItem[];
    try {
      // Klasör ağacı okunurken de "yükleniyor" görünmeli: büyük bir klasörde
      // ağacı gezmek saniyeler sürebiliyor.
      items = await itemsFromDataTransfer(event.dataTransfer);
    } catch {
      setUploading(false);
      toast.error("Klasör okunamadı", "Sürüklenen içerik listelenemedi.");
      return;
    }
    setUploading(false);
    await uploadItems(items);
  }

  async function extractArchive(entry: FileEntry) {
    setExtractBusy(true);
    try {
      const result = await api.extractArchive(domainId, joinPath(path, entry.name));
      toast.ok("Arşiv açıldı", `${entry.name} → ${result.extracted} dosya çıkarıldı.`);
      setExtracting(null);
      await load(path);
    } catch (err) {
      toast.error("Arşiv açılamadı", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setExtractBusy(false);
    }
  }

  async function saveFile(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      await api.updateFile(domainId, editing.path, editing.content);
      toast.ok("Kaydedildi", editing.path);
      setEditing(null);
      await load(path);
    } catch (err) {
      toast.error("Kaydedilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setSaving(false);
    }
  }

  const crumbs = path.split("/").filter(Boolean);

  return (
    <>
      <Panel>
        <PanelHead
          title={
            <>
              <FolderOpenIcon aria-hidden="true" />
              Dosya yöneticisi
            </>
          }
          note={
            <span className="sp-mono">
              {rootLabel}/{path}
            </span>
          }
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setPath(parentPath(path))} disabled={!path}>
                <ArrowUpIcon aria-hidden="true" />
                Üst klasör
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setDialogValue("");
                  setDialog({ kind: "new-folder" });
                }}
              >
                <FolderPlusIcon aria-hidden="true" />
                Klasör
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setDialogValue("");
                  setDialog({ kind: "new-file" });
                }}
              >
                <DocumentPlusIcon aria-hidden="true" />
                Dosya
              </Button>
              <Button size="sm" onClick={() => fileInputRef.current?.click()} loading={uploading}>
                <ArrowUpTrayIcon aria-hidden="true" />
                Dosya yükle
              </Button>
              <Button size="sm" onClick={() => folderInputRef.current?.click()} disabled={uploading}>
                <FolderArrowDownIcon aria-hidden="true" />
                Klasör yükle
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(event) => {
                  const items = itemsFromFileList(event.target.files ?? []);
                  event.target.value = "";
                  void uploadItems(items);
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                // webkitdirectory React'te tanımlı bir prop değil; DOM'a
                // olduğu gibi geçmesi için ref ile değil öznitelik olarak
                // veriyoruz. Klasör seçimini açan tek yol bu.
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                style={{ display: "none" }}
                onChange={(event) => {
                  const items = itemsFromFileList(event.target.files ?? []);
                  event.target.value = "";
                  void uploadItems(items);
                }}
              />
            </>
          }
        />

        {crumbs.length > 0 && (
          <div className="sp-crumb" style={{ padding: "8px 14px 0", margin: 0 }}>
            <button className="sp-link" onClick={() => setPath("")} type="button">
              {rootLabel}
            </button>
            {crumbs.map((part, index) => (
              <span key={`${part}-${index}`}>
                {" / "}
                <button
                  className="sp-link"
                  type="button"
                  onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}
                >
                  {part}
                </button>
              </span>
            ))}
          </div>
        )}

        {selected.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "10px 14px 0",
            }}
          >
            <span style={{ color: "var(--sp-ink-muted)", fontSize: 13 }}>
              {selected.length} öğe seçildi
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={() => setDeleting({ kind: "bulk", names: selected })}
            >
              <TrashIcon aria-hidden="true" />
              Seçilenleri kalıcı sil
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Seçimi temizle
            </Button>
          </div>
        )}

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={dragOver ? { outline: "2px dashed var(--sp-accent)", outlineOffset: -2 } : undefined}
        >
        {uploadProgress && <UploadProgressBar progress={uploadProgress} onCancel={cancelUpload} />}
        <PanelBody flush>
          {entries === null ? (
            <LoadingRow label="Dizin okunuyor" />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={FolderIcon}
              title="Bu klasör boş"
              text="Yukarıdaki Klasör/Dosya düğmesiyle ilk içeriği oluşturun ya da buraya dosya veya klasör sürükleyin."
            />
          ) : (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Tümünü seç"
                        checked={allSelected}
                        onChange={(event) =>
                          setSelected(event.target.checked ? entries.map((e) => e.name) : [])
                        }
                      />
                    </th>
                    <th>Ad</th>
                    <th className="sp-num">Boyut</th>
                    <th>Değiştirilme</th>
                    <th className="sp-cell-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.name}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${entry.name} seç`}
                          checked={selectedSet.has(entry.name)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, entry.name]
                                : current.filter((name) => name !== entry.name),
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => openEntry(entry)}
                          className="sp-row"
                          style={{
                            border: 0,
                            background: "transparent",
                            padding: 0,
                            gap: 7,
                            flexWrap: "nowrap",
                            minWidth: 0,
                          }}
                        >
                          {entry.type === "directory" ? (
                            <FolderIcon
                              style={{ width: 16, height: 16, color: "var(--sp-accent)", flex: "0 0 auto" }}
                              aria-hidden="true"
                            />
                          ) : (
                            <DocumentIcon
                              style={{ width: 16, height: 16, color: "var(--sp-ink-muted)", flex: "0 0 auto" }}
                              aria-hidden="true"
                            />
                          )}
                          <span style={{ textAlign: "left" }}>{entry.name}</span>
                        </button>
                      </td>
                      <td className="sp-num sp-mono" style={{ color: "var(--sp-ink-muted)" }}>
                        {entry.type === "directory" ? "—" : formatBytes(entry.size)}
                      </td>
                      <td style={{ color: "var(--sp-ink-muted)" }}>{formatDateTime(entry.mtimeMs)}</td>
                      <td className="sp-cell-actions">
                        {entry.type === "file" && isArchiveName(entry.name) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${entry.name} arşivini bu klasöre çıkart`}
                            title="Arşivi bu klasöre çıkart"
                            onClick={() => setExtracting(entry)}
                          >
                            <ArchiveBoxArrowDownIcon aria-hidden="true" />
                          </Button>
                        )}
                        {entry.type === "file" && (
                          <ButtonLink
                            variant="ghost"
                            size="icon"
                            href={api.downloadFileUrl(domainId, joinPath(path, entry.name))}
                            download={entry.name}
                            aria-label={`${entry.name} indir`}
                            title="Dosyayı indir"
                          >
                            <ArrowUpTrayIcon aria-hidden="true" />
                          </ButtonLink>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${entry.name} adını değiştir`}
                          onClick={() => {
                            setDialogValue(entry.name);
                            setDialog({ kind: "rename", entry });
                          }}
                        >
                          <PencilIcon aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${entry.name} sil`}
                          onClick={() => setDeleting({ kind: "single", entry })}
                        >
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
        </div>
      </Panel>

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === "rename"
            ? "Yeniden adlandır"
            : dialog?.kind === "new-folder"
              ? "Yeni klasör"
              : "Yeni dosya"
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={dialogBusy}>
              Vazgeç
            </Button>
            <Button
              variant="primary"
              onClick={(event) => submitDialog(event as unknown as FormEvent)}
              loading={dialogBusy}
              disabled={!dialogValue.trim()}
            >
              {dialog?.kind === "rename" ? "Adı değiştir" : "Oluştur"}
            </Button>
          </>
        }
      >
        <form onSubmit={submitDialog}>
          <Field
            label={dialog?.kind === "new-folder" ? "Klasör adı" : "Dosya adı"}
            hint={
              <>
                Şu konumda oluşturulacak: <span className="sp-mono">{rootLabel}/{path || ""}</span>
              </>
            }
          >
            <input
              className="sp-input sp-mono"
              value={dialogValue}
              onChange={(event) => setDialogValue(event.target.value)}
              placeholder={dialog?.kind === "new-folder" ? "assets" : "index.html"}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          if (deleting.kind === "single") await remove(deleting.entry);
          else await removeMany(deleting.names);
        }}
        title={
          deleting?.kind === "bulk"
            ? `${deleting.names.length} öğeyi sil`
            : deleting?.entry.type === "directory"
              ? "Klasörü sil"
              : "Dosyayı sil"
        }
        confirmLabel="Kalıcı olarak sil"
        description={
          deleting?.kind === "bulk" ? (
            <>
              Seçili <strong>{deleting.names.length}</strong> öğe sunucudan{" "}
              <strong>kalıcı olarak</strong> silinecek (çöp kutusu yok):{" "}
              <span className="sp-mono">
                {deleting.names.slice(0, 8).join(", ")}
                {deleting.names.length > 8 ? ` … (+${deleting.names.length - 8})` : ""}
              </span>
              . Klasör seçildiyse içindeki her şey de gider. Bu işlem geri alınamaz.
            </>
          ) : (
            <>
              <strong className="sp-mono">{joinPath(path, deleting?.entry.name ?? "")}</strong>{" "}
              sunucudan <strong>kalıcı olarak</strong> silinecek (çöp kutusu yok).
              {deleting?.entry.type === "directory" && " Klasörün içindeki her şey de gider."}{" "}
              Bu işlem geri alınamaz.
            </>
          )
        }
      />

      <ConfirmDialog
        open={extracting !== null}
        onClose={() => setExtracting(null)}
        destructive={false}
        confirmLabel={extractBusy ? "Açılıyor…" : "Arşivi çıkart"}
        onConfirm={async () => {
          if (extracting) await extractArchive(extracting);
        }}
        title="Arşivi çıkart"
        description={
          <>
            <strong className="sp-mono">{joinPath(path, extracting?.name ?? "")}</strong> içeriği{" "}
            <span className="sp-mono">
              {rootLabel}/{path}
            </span>{" "}
            klasörüne açılacak. Aynı adlı dosyalar <strong>üzerine yazılır</strong>. Arşiv dosyası
            yerinde kalır; çıkardıktan sonra silebilirsiniz.
          </>
        }
      />

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        wide
        title={<span className="sp-mono">{editing?.path}</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              Kapat
            </Button>
            <Button
              variant="primary"
              onClick={(event) => saveFile(event as unknown as FormEvent)}
              loading={saving}
            >
              Kaydet
            </Button>
          </>
        }
      >
        <textarea
          className="sp-textarea sp-mono"
          rows={20}
          value={editing?.content ?? ""}
          onChange={(event) => setEditing((current) => current && { ...current, content: event.target.value })}
          spellCheck={false}
          aria-label="Dosya içeriği"
        />
      </Modal>
    </>
  );
}
