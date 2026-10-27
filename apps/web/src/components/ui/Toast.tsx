"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

type Tone = "ok" | "err" | "info";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  text?: string;
}

interface ToastApi {
  /** İşlem başarıyla bitti. Buton hangi adı taşıyorsa toast da onu kullanır. */
  ok: (title: string, text?: string) => void;
  /** Ne olduğunu ve ne yapılacağını söyler; özür dilemez. */
  error: (title: string, text?: string) => void;
  info: (title: string, text?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<Tone, typeof CheckCircleIcon> = {
  ok: CheckCircleIcon,
  err: ExclamationTriangleIcon,
  info: InformationCircleIcon,
};

const DURATION: Record<Tone, number> = {
  ok: 4000,
  info: 5000,
  // Hata mesajı okunacak bir şey söylüyor; kendiliğinden kaybolmaz.
  err: 9000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone: Tone, title: string, text?: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, tone, title, text }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION[tone]),
      );
    },
    [dismiss],
  );

  // Sekme kapanırken/bileşen sökülürken bekleyen zamanlayıcılar kalmasın.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      ok: (title, text) => push("ok", title, text),
      error: (title, text) => push("err", title, text),
      info: (title, text) => push("info", title, text),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="sp-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone];
          return (
            <div key={toast.id} className="sp-toast" data-tone={toast.tone}>
              <Icon aria-hidden="true" />
              <div className="sp-toast-body">
                <div className="sp-toast-title">{toast.title}</div>
                {toast.text && <div className="sp-toast-text">{toast.text}</div>}
              </div>
              <button className="sp-toast-close" onClick={() => dismiss(toast.id)} aria-label="Bildirimi kapat">
                <XMarkIcon aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast, ToastProvider içinde kullanılmalı.");
  return context;
}
