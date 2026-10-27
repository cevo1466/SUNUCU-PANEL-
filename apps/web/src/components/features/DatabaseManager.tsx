"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowTopRightOnSquareIcon,
  ArrowUpTrayIcon,
  CircleStackIcon,
  ClipboardIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  api,
  ApiError,
  DB_ENGINE_LABEL,
  type DbConnection,
  type DbEngine,
  type DbEngineStatus,
  type PanelDatabase,
} from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Badge, EmptyState, Field, LoadingRow, Note } from "@/components/ui/Bits";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

/** Parola + bağlantı bilgisi, yalnızca bir kez gösterilir. */
interface RevealedCredentials {
  title: string;
  database: PanelDatabase;
  password: string;
  connection: DbConnection;
}

export function DatabaseManager({ domainId }: { domainId: number }) {
  const toast = useToast();
  const [databases, setDatabases] = useState<PanelDatabase[] | null>(null);
  const [engines, setEngines] = useState<DbEngineStatus[]>([]);
  /** Dışarıdan SQL yükleme: hedef veritabanı ve seçilen dosya. */
  const [importing, setImporting] = useState<PanelDatabase | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [adminerUrl, setAdminerUrl] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [engine, setEngine] = useState<DbEngine>("postgres");
  const [dbName, setDbName] = useState("");
  const [dbUser, setDbUser] = useState("");
  const [customPassword, setCustomPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<RevealedCredentials | null>(null);
  const [deleting, setDeleting] = useState<PanelDatabase | null>(null);
  const [resetting, setResetting] = useState<PanelDatabase | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");

  function engineLabel(item: { engine: DbEngine; label: string | null }): string {
    return item.label ?? DB_ENGINE_LABEL[item.engine];
  }

  const load = useCallback(async () => {
    try {
      const result = await api.listDatabases(domainId);
      setDatabases(result.databases);
      setEngines(result.engines);
      setSuggestion(result.suggestion);
      setAdminerUrl(result.adminerUrl);
    } catch (error) {
      setDatabases([]);
      toast.error(
        "Veritabanları alınamadı",
        error instanceof ApiError ? error.message : "Sunucuya ulaşılamadı.",
      );
    }
  }, [domainId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedEngine = useMemo(
    () => engines.find((item) => item.engine === engine) ?? null,
    [engines, engine],
  );

  /**
   * Yeni veritabanı için çakışmayan bir ad önerir. Aynı domain için ikinci
   * veritabanı açılırken kullanıcı adı elle uydurmak zorunda kalmasın.
   */
  function nextFreeName(base: string, forEngine: DbEngine): string {
    const taken = new Set(
      (databases ?? []).filter((d) => d.engine === forEngine).map((d) => d.db_name),
    );
    if (!taken.has(base)) return base;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}_${index}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
  }

  function openCreate() {
    // İlk uygun motoru seç: kurulu olmayan bir motorla form açmak anlamsız.
    const firstAvailable = engines.find((item) => item.available)?.engine ?? "postgres";
    const name = nextFreeName(suggestion || "app", firstAvailable);
    setEngine(firstAvailable);
    setDbName(name);
    setDbUser(name);
    setCustomPassword("");
    setCreateOpen(true);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.createDatabase(domainId, {
        engine,
        dbName,
        dbUser,
        password: customPassword.trim() || undefined,
      });
      setCreateOpen(false);
      setRevealed({
        title: "Veritabanı hazır",
        database: result.database,
        password: result.password,
        connection: result.connection,
      });
      await load();
      toast.ok("Veritabanı oluşturuldu", `${DB_ENGINE_LABEL[engine]} · ${result.database.db_name}`);
    } catch (error) {
      toast.error(
        "Veritabanı oluşturulamadı",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  function openReset(database: PanelDatabase) {
    setResetPasswordValue("");
    setResetting(database);
  }

  async function resetPassword() {
    if (!resetting) return;
    const database = resetting;
    try {
      const result = await api.resetDatabasePassword(
        domainId,
        database.id,
        resetPasswordValue.trim() || undefined,
      );
      setResetting(null);
      setRevealed({
        title: "Yeni parola",
        database,
        password: result.password,
        connection: result.connection,
      });
      toast.ok("Parola değiştirildi", database.db_user);
    } catch (error) {
      toast.error(
        "Parola değiştirilemedi",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    }
  }

  async function remove(database: PanelDatabase) {
    try {
      await api.deleteDatabase(domainId, database.id);
      await load();
      toast.ok("Veritabanı silindi", database.db_name);
    } catch (error) {
      toast.error(
        "Veritabanı silinemedi",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    }
  }

  const unavailable = engines.filter((item) => !item.available);
  const anyAvailable = engines.some((item) => item.available);

  async function runImport() {
    if (!importing || !importFile) return;
    setImportBusy(true);
    try {
      const result = await api.importDatabase(domainId, importing.id, importFile);
      setImporting(null);
      setImportFile(null);
      if (result.warnings.length > 0) {
        // Uyarilar YUTULMAZ: "yuklendi" deyip sessizce eksik birakmak, bu
        // panelde tekrar tekrar duzeltilen hata sinifinin ta kendisi.
        toast.error(
          `${result.database} yüklendi — uyarılarla`,
          result.warnings.slice(0, 3).join(" · "),
        );
      } else {
        toast.ok(
          "Veritabanı yüklendi",
          `${result.database} · ${formatBytes(result.bytes)}${result.gzipped ? " (gzip açıldı)" : ""}`,
        );
      }
    } catch (error) {
      toast.error(
        "Yükleme tamamlanamadı",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <>
      <Panel>
        <PanelHead
          title={
            <>
              <CircleStackIcon aria-hidden="true" />
              Veritabanları
            </>
          }
          actions={
            <>
              {adminerUrl && (
                <a
                  className="sp-btn sp-btn--secondary sp-btn--sm"
                  href={adminerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  Adminer&apos;ı aç
                </a>
              )}
              <Button size="sm" variant="primary" onClick={openCreate} disabled={!anyAvailable}>
                <PlusIcon aria-hidden="true" />
                Veritabanı oluştur
              </Button>
            </>
          }
        />

        {unavailable.length > 0 && (
          <div style={{ padding: "12px 14px 0" }}>
            {unavailable.map((item) => (
              <Note key={item.engine} tone="warn">
                <strong>{engineLabel(item)}</strong> kullanılamıyor. {item.note}
              </Note>
            ))}
          </div>
        )}

        <PanelBody flush>
          {databases === null ? (
            <LoadingRow label="Veritabanları okunuyor" />
          ) : databases.length === 0 ? (
            <EmptyState
              icon={CircleStackIcon}
              title="Henüz veritabanı yok"
              text="Bu domainin uygulaması için bir veritabanı ve ona özel bir kullanıcı oluşturun."
            />
          ) : (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th>Motor</th>
                    <th>Veritabanı</th>
                    <th>Kullanıcı</th>
                    <th>Oluşturma</th>
                    <th className="sp-cell-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {databases.map((database) => {
                    const status = engines.find((item) => item.engine === database.engine);
                    return (
                      <tr key={database.id}>
                        <td>
                          <Badge tone={status?.available ? "ok" : "warn"}>
                            {status ? engineLabel(status) : DB_ENGINE_LABEL[database.engine]}
                          </Badge>
                        </td>
                        <td className="sp-mono">{database.db_name}</td>
                        <td className="sp-mono">{database.db_user}</td>
                        <td>{formatDate(database.created_at)}</td>
                        <td className="sp-cell-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setImportFile(null);
                              setImporting(database);
                            }}
                          >
                            <ArrowUpTrayIcon aria-hidden="true" />
                            SQL yükle
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openReset(database)}>
                            <KeyIcon aria-hidden="true" />
                            Parola
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`${database.db_name} veritabanını sil`}
                            onClick={() => setDeleting(database)}
                          >
                            <TrashIcon aria-hidden="true" />
                          </Button>
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

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Veritabanı oluştur"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>
              Vazgeç
            </Button>
            <Button variant="primary" type="submit" form="db-create-form" loading={busy}>
              Oluştur
            </Button>
          </>
        }
      >
        <form id="db-create-form" className="sp-stack" onSubmit={create}>
          <Field label="Motor">
            <select
              className="sp-input"
              value={engine}
              onChange={(event) => {
                const next = event.target.value as DbEngine;
                setEngine(next);
                const name = nextFreeName(suggestion || "app", next);
                setDbName(name);
                setDbUser(name);
              }}
            >
              {engines.map((item) => (
                <option key={item.engine} value={item.engine} disabled={!item.available}>
                  {engineLabel(item)}
                  {item.available ? "" : " — kurulu değil"}
                </option>
              ))}
            </select>
          </Field>

          {selectedEngine && (
            <Note tone={selectedEngine.available ? "info" : "warn"}>
              {selectedEngine.available
                ? `Sunucu: ${selectedEngine.host}:${selectedEngine.port}`
                : selectedEngine.note}
            </Note>
          )}

          <Field
            label="Veritabanı adı"
            hint="Küçük harfle başlar; en fazla 63 karakter, yalnızca küçük harf, rakam ve _ ."
          >
            <input
              className="sp-input sp-mono"
              value={dbName}
              onChange={(event) => setDbName(event.target.value)}
              required
            />
          </Field>

          <Field label="Kullanıcı adı" hint="Bu veritabanına özel kullanıcı. Aynı kurallar geçerli.">
            <input
              className="sp-input sp-mono"
              value={dbUser}
              onChange={(event) => setDbUser(event.target.value)}
              required
            />
          </Field>

          <Field
            label="Parola (opsiyonel)"
            hint="Boş bırakılırsa güvenli bir parola otomatik üretilir. Doldurursanız 8-72 karakter, harf/rakam/!@#$%^&*_+=- içerebilir."
          >
            <input
              className="sp-input sp-mono"
              type="text"
              value={customPassword}
              onChange={(event) => setCustomPassword(event.target.value)}
              placeholder="otomatik üretilecek"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Note tone="info">
            Parola yalnızca bir kez gösterilir. Panel parolayı saklamaz; kaybederseniz sıfırlarsınız.
          </Note>
        </form>
      </Modal>

      <Modal
        open={resetting !== null}
        onClose={() => setResetting(null)}
        title="Parolayı değiştir"
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetting(null)}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={() => void resetPassword()}>
              Parolayı değiştir
            </Button>
          </>
        }
      >
        {resetting && (
          <div className="sp-stack">
            <p className="sp-hint">
              <span className="sp-mono">{resetting.db_user}</span> kullanıcısının parolasını
              değiştirin.
            </p>
            <Field
              label="Yeni parola (opsiyonel)"
              hint="Boş bırakılırsa güvenli bir parola otomatik üretilir."
            >
              <input
                className="sp-input sp-mono"
                type="text"
                value={resetPasswordValue}
                onChange={(event) => setResetPasswordValue(event.target.value)}
                placeholder="otomatik üretilecek"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title={revealed?.title ?? ""}
        footer={
          <Button variant="primary" onClick={() => setRevealed(null)}>
            Bilgileri kaydettim
          </Button>
        }
      >
        {revealed && (
          <div className="sp-stack">
            <Note tone="warn">
              Bu parola yalnızca şimdi gösterilir. Kapatmadan önce güvenli bir yere kaydedin.
            </Note>
            <table className="sp-table">
              <tbody>
                <tr>
                  <th>Sunucu</th>
                  <td className="sp-mono">
                    {revealed.connection.host}:{revealed.connection.port}
                  </td>
                </tr>
                <tr>
                  <th>Veritabanı</th>
                  <td className="sp-mono">{revealed.database.db_name}</td>
                </tr>
                <tr>
                  <th>Kullanıcı</th>
                  <td className="sp-mono">{revealed.database.db_user}</td>
                </tr>
                <tr>
                  <th>Parola</th>
                  <td className="sp-mono">{revealed.password}</td>
                </tr>
              </tbody>
            </table>
            {/*
              Bağlantı adresi hakkında dürüst olma. host 127.0.0.1 ve PostgreSQL
              5433'te (varsayılan 5432 DEĞİL); ayrıca hem PostgreSQL hem
              MariaDB yalnızca loopback dinliyor. Bu bilgiler sunucu ÜZERİNDEN
              (Adminer) geçerlidir; kullanıcının kendi bilgisayarındaki bir
              masaüstü istemcisi bu adrese ulaşamaz. Bunu yazmazsak kullanıcı
              DBeaver'a girip "bağlanamıyorum" ile karşılaşır.
            */}
            <Note>
              Bu adres sunucunun kendi içinden geçerlidir — yukarıdaki
              &quot;Adminer&apos;ı aç&quot; bağlantısıyla doğrudan kullanabilirsiniz.
              Kendi bilgisayarınızdaki bir istemciyle (DBeaver, TablePlus)
              bağlanmak için SSH tüneli gerekir; veritabanı sunucuları dışarıya
              kapalıdır.
            </Note>
            <div className="sp-row">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(revealed.password)}
              >
                <ClipboardIcon aria-hidden="true" />
                Parolayı kopyala
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    connectionString(revealed.database, revealed.password, revealed.connection),
                  )
                }
              >
                <ClipboardIcon aria-hidden="true" />
                Bağlantı dizesini kopyala
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={importing !== null}
        onClose={() => {
          if (!importBusy) setImporting(null);
        }}
        title={`${importing?.db_name ?? ""} içine SQL yükle`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setImporting(null)} disabled={importBusy}>
              Vazgeç
            </Button>
            <Button
              variant="primary"
              onClick={runImport}
              loading={importBusy}
              disabled={!importFile}
            >
              Yükle
            </Button>
          </>
        }
      >
        <div className="sp-stack">
          <Field
            label="SQL dosyası"
            hint="Düz .sql veya gzip'li .sql.gz. Biçim uzantıdan değil dosya içeriğinden anlaşılır."
          >
            <input
              className="sp-input"
              type="file"
              accept=".sql,.gz,.sql.gz,application/sql,application/gzip,text/plain"
              onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
            />
          </Field>
          {importFile && (
            <p className="sp-hint">
              Seçilen: <span className="sp-mono">{importFile.name}</span> ·{" "}
              {formatBytes(importFile.size)}
            </p>
          )}
          <Note tone="warn">
            Dökümdeki tablolar <strong>{importing?.db_name}</strong> içine yazılır ve aynı adlı
            mevcut tabloların üzerine gelebilir. Yükleme yalnızca bu veritabanının içine yapılır;
            dosyadaki <span className="sp-mono">CREATE DATABASE</span> satırları reddedilir.
            Büyük dosyalarda işlem birkaç dakika sürebilir.
          </Note>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        title="Veritabanını sil"
        description={
          deleting
            ? `${deleting.db_name} veritabanı ve ${deleting.db_user} kullanıcısı sunucudan kalıcı olarak silinecek. İçindeki veriler geri getirilemez.`
            : ""
        }
        confirmLabel="Veritabanını sil"
      />
    </>
  );
}

/** Uygulama yapılandırmasına doğrudan yapıştırılabilir bağlantı dizesi. */
function connectionString(
  database: PanelDatabase,
  password: string,
  connection: DbConnection,
): string {
  const scheme = database.engine === "postgres" ? "postgres" : "mysql";
  // Parola alfabesi zaten URL'de anlam taşıyan karakter içermiyor
  // (bkz. generateDbPassword), yine de kodlanarak yazılıyor.
  return `${scheme}://${database.db_user}:${encodeURIComponent(password)}@${connection.host}:${connection.port}/${database.db_name}`;
}
