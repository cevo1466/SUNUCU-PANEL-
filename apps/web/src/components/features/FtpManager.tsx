"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ClipboardIcon, PlusIcon, ServerStackIcon, TrashIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type FtpAccount, type FtpServiceStatus } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Badge, EmptyState, Field, LoadingRow, Note } from "@/components/ui/Bits";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PASSWORD_HINT, passwordProblem } from "@studio-panel/shared";

export function FtpManager({ domainId }: { domainId: number }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<FtpAccount[] | null>(null);
  const [service, setService] = useState<FtpServiceStatus | null>(null);
  const [suggested, setSuggested] = useState("ftp");
  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [quota, setQuota] = useState("");
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<FtpAccount | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listFtpAccounts(domainId);
      setAccounts(result.accounts);
      setService(result.service);
      setSuggested(result.suggestedUsername);
    } catch (error) {
      setAccounts([]);
      toast.error("FTP hesapları alınamadı", error instanceof ApiError ? error.message : "Sunucuya ulaşılamadı.");
    }
  }, [domainId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    // Parola BOS BIRAKILABILIR (sunucu uretir); yazildiysa kurala uymali.
    const problem = password ? passwordProblem(password) : null;
    setPasswordError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const result = await api.createFtpAccount(domainId, {
        username,
        ...(password ? { password } : {}),
        quotaMb: quota ? Number(quota) : null,
      });
      setCreateOpen(false);
      setPassword("");
      setPasswordError(null);
      setQuota("");
      setRevealedPassword(result.password);
      await load();
      toast.ok("FTP hesabı oluşturuldu", result.account.username);
    } catch (error) {
      toast.error("FTP hesabı oluşturulamadı", error instanceof ApiError ? error.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(account: FtpAccount) {
    try {
      await api.updateFtpAccount(domainId, account.id, { enabled: !account.enabled });
      await load();
      toast.ok(account.enabled ? "FTP hesabı durduruldu" : "FTP hesabı etkinleştirildi");
    } catch (error) {
      toast.error("Hesap güncellenemedi", error instanceof ApiError ? error.message : "İşlem tamamlanmadı.");
    }
  }

  async function remove(account: FtpAccount) {
    try {
      await api.deleteFtpAccount(domainId, account.id);
      await load();
      toast.ok("FTP hesabı silindi", account.username);
    } catch (error) {
      toast.error("FTP hesabı silinemedi", error instanceof ApiError ? error.message : "İşlem tamamlanmadı.");
    }
  }

  return (
    <>
      <Panel>
        <PanelHead
          title={<><ServerStackIcon aria-hidden="true" />FTP hesapları</>}
          actions={
            <Button size="sm" variant="primary" onClick={() => {
              setUsername(suggested);
              setCreateOpen(true);
            }}>
              <PlusIcon aria-hidden="true" />Hesap oluştur
            </Button>
          }
        />
        {service && !service.running && (
          <div style={{ padding: "12px 14px 0" }}>
            <Note tone="warn">{service.note} Hesap tanımları hazır tutulur; servis kurulup başlatılınca kullanılabilir.</Note>
          </div>
        )}
        <PanelBody flush>
          {accounts === null ? <LoadingRow label="FTP hesapları okunuyor" /> : accounts.length === 0 ? (
            <EmptyState icon={ServerStackIcon} title="Henüz FTP hesabı yok" text="Bu domainin dosyalarına erişecek ilk hesabı oluşturun." />
          ) : (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead><tr><th>Kullanıcı</th><th>Ana dizin</th><th>Kota</th><th>Oluşturma</th><th>Durum</th><th className="sp-cell-actions">İşlem</th></tr></thead>
                <tbody>{accounts.map((account) => (
                  <tr key={account.id}>
                    <td className="sp-mono">{account.username}</td>
                    <td className="sp-mono">{account.home_dir}</td>
                    <td>{account.quota_mb ? `${account.quota_mb} MB` : "Sınırsız"}</td>
                    <td>{formatDate(account.created_at)}</td>
                    <td><Badge tone={account.enabled ? "ok" : "neutral"}>{account.enabled ? "Etkin" : "Kapalı"}</Badge></td>
                    <td className="sp-cell-actions">
                      <Button size="sm" variant="ghost" onClick={() => void toggle(account)}>{account.enabled ? "Durdur" : "Etkinleştir"}</Button>
                      <Button size="icon" variant="ghost" aria-label={`${account.username} hesabını sil`} onClick={() => setDeleting(account)}><TrashIcon aria-hidden="true" /></Button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </PanelBody>
      </Panel>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="FTP hesabı oluştur" footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>Vazgeç</Button><Button variant="primary" type="submit" form="ftp-create-form" loading={busy}>Oluştur</Button></>}>
        <form id="ftp-create-form" className="sp-stack" onSubmit={create}>
          <Field label="Kullanıcı adı" hint="3-32 karakter; küçük harf, rakam, _ ve - kullanın."><input className="sp-input sp-mono" value={username} onChange={(event) => setUsername(event.target.value)} required /></Field>
          {/* minLength YOK: kural saglanmayinca tarayici formu SESSIZCE
              gondermiyor ve gonder butonu diyalogun altbilgisinde oldugu icin
              uyari baloncugu cogu zaman gorunmuyordu — kullanici "Olustur"a
              basiyor, hicbir sey olmuyordu (ayni tuzak e-posta formunda da
              vardi). Dogrulama artik alanin altinda, Turkce ve gorunur. */}
          <Field
            label="Parola"
            hint={`${PASSWORD_HINT} Boş bırakırsanız güvenli bir parola üretilir ve yalnızca bir kez gösterilir.`}
            error={passwordError ?? undefined}
          >
            <input
              className="sp-input"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (passwordError) setPasswordError(null);
              }}
            />
          </Field>
          <Field label="Kota (MB)" hint="Boş bırakırsanız kota uygulanmaz."><input className="sp-input" type="number" min={10} max={1048576} value={quota} onChange={(event) => setQuota(event.target.value)} /></Field>
        </form>
      </Modal>

      <Modal open={revealedPassword !== null} onClose={() => setRevealedPassword(null)} title="FTP hesabı hazır" footer={<Button variant="primary" onClick={() => setRevealedPassword(null)}>Parolayı kaydettim</Button>}>
        <div className="sp-stack">
          <Note tone="warn">Bu parola yalnızca şimdi gösterilir. Kapatmadan önce güvenli bir parola yöneticisine kaydedin.</Note>
          <div className="sp-row"><code className="sp-mono" style={{ flex: 1 }}>{revealedPassword}</code><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(revealedPassword ?? "")}><ClipboardIcon aria-hidden="true" />Kopyala</Button></div>
        </div>
      </Modal>

      <ConfirmDialog open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => deleting ? remove(deleting) : undefined} title="FTP hesabını sil" description={deleting ? `${deleting.username} hesabı kalıcı olarak silinecek. Domain dosyaları silinmez.` : ""} confirmLabel="Hesabı sil" />
    </>
  );
}
