"use client";

import { useState, type FormEvent } from "react";
import { ClipboardIcon, TrashIcon, UserIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type Domain } from "@/lib/api";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button } from "@/components/ui/button";
import { Field, Note } from "@/components/ui/Bits";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { PASSWORD_HINT, passwordProblem } from "@studio-panel/shared";

/**
 * Domain başına, ana panel admin girişinden bağımsız bir müşteri girişi.
 * Müşteri hesabı bu domain'in `user_id`'sine bağlanır; panelin mevcut
 * sahiplik kontrolü (getOwnedDomain) bu hesabın yalnızca bu domain'i
 * görebilmesini otomatik sağlar — bkz. apps/api/src/lib/domain.ts.
 */
/**
 * Kurallar sunucudaki zod semasiyla (routes/domains.ts customerAccountSchema)
 * BIREBIR ayni. Burada tekrarlanmalarinin sebebi kullaniciya GONDERMEDEN once
 * sebebi soyleyebilmek; sunucu yine de son sozu soyler.
 */
const MIN_USERNAME = 3;

function validateCustomer(username: string, email: string, password: string) {
  const errors: { username?: string; email?: string; password?: string } = {};
  const user = username.trim();
  if (user.length < MIN_USERNAME) {
    errors.username = `Kullanıcı adı en az ${MIN_USERNAME} karakter olmalı — şu an ${user.length}.`;
  }
  const mail = email.trim();
  if (!mail) errors.email = "E-posta boş bırakılamaz.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) {
    errors.email = "Geçerli bir e-posta adresi yazın.";
  }
  // Parola OPSIYONEL: bos birakilirsa sunucu uretir. Ama yazildiysa kurala uymali.
  const pass = password.trim();
  if (pass) {
    const problem = passwordProblem(pass);
    if (problem) errors.password = problem;
  }
  return errors;
}

export function CustomerAccessManager({
  domain,
  onChange,
}: {
  domain: Domain;
  onChange?: () => void;
}) {
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState(domain.customer_email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [formErrors, setFormErrors] = useState<{ username?: string; email?: string; password?: string }>({});

  async function save(event: FormEvent) {
    event.preventDefault();
    const found = validateCustomer(username, email, password);
    setFormErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const result = await api.setCustomerAccount(domain.id, {
        username,
        email,
        password: password.trim() || undefined,
      });
      setRevealed({ email: result.user.email, password: result.password });
      setUsername("");
      setPassword("");
      setFormErrors({});
      onChange?.();
      toast.ok("Müşteri girişi hazır", result.user.email);
    } catch (err) {
      toast.error(
        "Müşteri hesabı kaydedilemedi",
        err instanceof ApiError ? err.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api.removeCustomerAccount(domain.id);
      onChange?.();
      toast.ok("Müşteri girişi kaldırıldı", domain.domain_name);
    } catch (err) {
      toast.error(
        "Kaldırılamadı",
        err instanceof ApiError ? err.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setRemoving(false);
      setConfirmingRemove(false);
    }
  }

  return (
    <Panel>
      <PanelHead
        title={
          <>
            <UserIcon aria-hidden="true" />
            Müşteri girişi
          </>
        }
        actions={
          domain.has_customer_account ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(true)} loading={removing}>
              <TrashIcon aria-hidden="true" />
              Kaldır
            </Button>
          ) : undefined
        }
      />
      <PanelBody>
        <div className="sp-stack">
          <p className="sp-hint">
            {domain.has_customer_account ? (
              <>
                Bu domain şu anda <strong className="sp-mono">{domain.customer_email}</strong>{" "}
                hesabına bağlı. Bu hesap ana panel yöneticisinden bağımsızdır; yalnızca bu domaini
                görüp yönetebilir. Bilgileri güncellemek için formu tekrar doldurun.
              </>
            ) : (
              "Bu domain için ayrı, ana panelden bağımsız bir giriş açın. Bu hesap sadece bu domaini görür ve yönetir; yeni domain oluşturamaz veya bu domaini silemez."
            )}
          </p>

          <form className="sp-stack" onSubmit={save}>
            <Field
              label="Kullanıcı adı"
              hint={`En az ${MIN_USERNAME} karakter. Müşteri panele bu adla girer.`}
              error={formErrors.username}
            >
              <input
                className="sp-input sp-mono"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  if (formErrors.username) setFormErrors((prev) => ({ ...prev, username: undefined }));
                }}
                placeholder={domain.domain_name.replace(/[^a-z0-9]/gi, "_")}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="E-posta" hint="Müşteri bu e-posta ile giriş yapar." error={formErrors.email}>
              <input
                className="sp-input sp-mono"
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (formErrors.email) setFormErrors((prev) => ({ ...prev, email: undefined }));
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Parola (opsiyonel)"
              hint={`Boş bırakılırsa güvenli bir parola otomatik üretilir. ${PASSWORD_HINT}`}
              error={formErrors.password}
            >
              <input
                className="sp-input sp-mono"
                type="text"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (formErrors.password) setFormErrors((prev) => ({ ...prev, password: undefined }));
                }}
                placeholder="otomatik üretilecek"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div>
              <Button type="submit" variant="primary" loading={busy}>
                {domain.has_customer_account ? "Bilgileri güncelle" : "Müşteri girişi oluştur"}
              </Button>
            </div>
          </form>

          {revealed && (
            <Note tone="warn">
              <div className="sp-stack" style={{ gap: 6 }}>
                <span>
                  Parola yalnızca şimdi gösterilir — <strong className="sp-mono">{revealed.email}</strong>{" "}
                  için: <strong className="sp-mono">{revealed.password}</strong>
                </span>
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void navigator.clipboard.writeText(revealed.password)}
                  >
                    <ClipboardIcon aria-hidden="true" />
                    Parolayı kopyala
                  </Button>
                </div>
              </div>
            </Note>
          )}
        </div>
      </PanelBody>

      <ConfirmDialog
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        onConfirm={remove}
        title="Müşteri girişini kaldır"
        description={
          <>
            <span className="sp-mono">{domain.customer_email}</span> hesabı silinecek ve domain
            yeniden ana yönetici hesabına bağlanacak. Bu işlem geri alınamaz.
          </>
        }
      />
    </Panel>
  );
}
