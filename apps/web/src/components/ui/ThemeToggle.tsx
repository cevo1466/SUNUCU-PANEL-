"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/button";
import { applyTheme, readTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

/**
 * Açık/koyu tema düğmesi.
 *
 * Başlangıç değeri sunucuda BİLİNEMEZ: tema `<head>` içindeki senkron betik
 * tarafından localStorage'dan (veya sistem tercihinden) uygulanıyor, sunucu
 * ikisini de göremiyor. Bu yüzden ilk render nötr bir iskelet basar ve gerçek
 * değer effect içinde okunur — sunucu ile istemci çıktısı ayrışmadığı için
 * hydration uyarısı çıkmaz.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  // Kullanıcının kendi seçimi yokken sistem tercihi değişirse (ör. akşam
  // otomatik koyu moda geçen işletim sistemi) panel de takip etsin.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange(event: MediaQueryListEvent) {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        /* okunamadı: seçim yok say */
      }
      if (stored === "light" || stored === "dark") return; // kullanıcı seçimi kazanır
      const next: Theme = event.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      setTheme(next);
    }
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  // theme null iken (ilk render) ikon seçilemez; yer tutucu genişlik korunur
  // ki tema okununca üst çubuk zıplamasın.
  const isDark = theme === "dark";
  const label = theme === null ? "Tema" : isDark ? "Açık temaya geç" : "Koyu temaya geç";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-pressed={theme === null ? undefined : isDark}
    >
      {theme === null ? (
        <span className="sp-theme-toggle-placeholder" aria-hidden="true" />
      ) : isDark ? (
        <SunIcon aria-hidden="true" />
      ) : (
        <MoonIcon aria-hidden="true" />
      )}
    </Button>
  );
}
