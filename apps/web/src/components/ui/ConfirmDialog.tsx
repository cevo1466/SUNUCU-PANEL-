"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { Button } from "./button";

/**
 * Geri alınamaz işlemler için onay. `confirmPhrase` verildiğinde kullanıcı o
 * metni harfi harfine yazana kadar buton kilitli kalır — domain silmek gibi
 * dosyaları da götüren işlemlerde kazara tıklamayı engeller.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Sil",
  confirmPhrase,
  destructive = true,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  confirmPhrase?: string;
  destructive?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTyped("");
      setBusy(false);
    }
  }, [open]);

  const phraseOk = !confirmPhrase || typed === confirmPhrase;

  async function confirm() {
    if (!phraseOk) return;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={confirm}
            disabled={!phraseOk}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="sp-stack">
        <div className="sp-hint" style={{ lineHeight: 1.55 }}>
          {description}
        </div>
        {confirmPhrase && (
          <label className="sp-field">
            <span className="sp-label">
              Onaylamak için <strong className="sp-mono">{confirmPhrase}</strong> yazın
            </span>
            <input
              className="sp-input sp-mono"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && phraseOk) confirm();
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
      </div>
    </Modal>
  );
}
