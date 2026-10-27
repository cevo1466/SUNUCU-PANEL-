"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * prompt()/alert() yerine kullanılan diyalog. Odak içeride tutulur, Esc kapatır,
 * arka plan tıklaması kapatır — panelin kendi görünümünde kalır.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  /**
   * Klavye işleyicisi bir ref'te tutulur — ve bu ZORUNLU.
   *
   * GERÇEK ARIZA (2026-09-02): efektin bağımlılığı `[open, handleKeyDown]`'du.
   * `handleKeyDown` bir useCallback ve bağımlılığı `onClose`; çağıran taraf
   * ise her yerde satır içi ok fonksiyonu veriyor
   * (`onClose={() => setCreateOpen(false)}`). Satır içi fonksiyon her
   * render'da YENİ bir kimliktir, dolayısıyla `handleKeyDown` de yeniydi ve
   * efekt HER RENDER'DA yeniden çalışıyordu. Diyalogdaki bir alana yazmak
   * render tetiklediği için, her tuş vuruşunda:
   *   temizlik  -> odak diyalog açılmadan önceki öğeye geri döner
   *   yeni tur  -> odak diyalogdaki İLK alana zorlanır
   * Yani kullanıcı parola alanına bir harf yazıyor ve odak ilk alana
   * sıçrıyordu; parola belirlemek imkânsızdı. Panelin BÜTÜN diyaloglarını
   * etkiliyordu (e-posta, müşteri hesabı, veritabanı, kota...).
   *
   * Ref sayesinde efekt yalnızca `open` değiştiğinde çalışır; dinleyici
   * güncel işleyiciyi ref üzerinden okur.
   */
  const keyHandlerRef = useRef(handleKeyDown);
  keyHandlerRef.current = handleKeyDown;

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    document.addEventListener("keydown", listener, true);

    // İlk alana odaklan; alan yoksa diyaloğun kendisine. YALNIZCA AÇILIŞTA.
    const firstField = dialogRef.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea',
    );
    (firstField ?? dialogRef.current)?.focus();

    return () => {
      document.removeEventListener("keydown", listener, true);
      document.body.style.overflow = previousOverflow;
      restoreFocusTo.current?.focus?.();
    };
    // Bilerek yalnızca `open`: bkz. yukarıdaki açıklama.
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="sp-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={cn("sp-modal", wide && "sp-modal--wide")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="sp-modal-head">
          <h2 className="sp-modal-title" id={titleId}>
            {title}
          </h2>
          <div style={{ marginLeft: "auto" }}>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Kapat">
              <XMarkIcon aria-hidden="true" />
            </Button>
          </div>
        </header>
        <div className="sp-modal-body">{children}</div>
        {footer && <footer className="sp-modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
