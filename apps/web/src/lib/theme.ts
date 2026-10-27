/**
 * Tema (açık/koyu) — tek kaynak.
 *
 * Seçim `<html data-theme="...">` üzerinden uygulanır; renkler globals.css'teki
 * token katmanında tanımlıdır (`:root` açık, `:root[data-theme="dark"]` koyu).
 * Bileşenler temayı BİLMEZ, yalnızca token okur.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "studio-panel:theme";

/**
 * Sayfa boyanmadan ÖNCE `<head>` içinde çalışan betik.
 *
 * NEDEN GEREKLİ: tema React'te uygulanırsa ilk boyama her zaman açık temayla
 * yapılır ve koyu tema kullanıcısı her gezinmede beyaz bir flaş görür (FOUC).
 * Bu betik senkron çalışır, `data-theme`'i ilk boyamadan önce yerine koyar.
 *
 * localStorage erişimi try/catch içinde: gizli sekmede veya site verisi
 * engelliyse okuma İSTİSNA FIRLATIR ve betik burada patlarsa sayfa hiç
 * boyanmaz. Hata durumunda sistem tercihine düşülür.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
`.trim();

/** Şu an uygulanmış tema. Sunucuda çağrılmaz. */
export function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * Temayı uygular ve kalıcılaştırır.
 *
 * Yazma başarısız olsa bile (gizli sekme, site verisi kapalı) tema o oturum
 * için uygulanır — kalıcılık kaybolur, işlev kaybolmaz.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* yoksay: tercih saklanamadı, tema yine de uygulandı */
  }
}
