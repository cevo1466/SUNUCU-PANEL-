"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, ApiError, type CurrentUser, type Domain } from "@/lib/api";
import { Sidebar, SidebarContent } from "./Sidebar";
import { Topbar } from "./Topbar";

interface ShellContextValue {
  user: CurrentUser | null;
  domains: Domain[] | null;
  domainsError: string | null;
  /** Domain listesini yeniden çeker. Ekleme/silme sonrası çağrılır. */
  reloadDomains: () => Promise<void>;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** Kabuğun bir kez yüklediği oturum ve domain listesine erişim. */
export function useShell(): ShellContextValue {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useShell, AppShell içinde kullanılmalı.");
  return context;
}

/**
 * Panelin dış kabuğu: sol menü, üst bar, mobil çekmece.
 * Oturum, domain listesi ve servis sağlığı burada bir kez yüklenir; her sayfa
 * ayrı ayrı /api/auth/me çağırmaz.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [dbState, setDbState] = useState<"ok" | "err" | "idle">("idle");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Oturum çözülene kadar sayfa içeriği ÇİZİLMEZ. Aksi halde boş verilerle
  // dolu bir panel bir an görünür, sonra /login'e atlanırdı — panel "sanki
  // ilk kurulmuş" gibi duruyordu. middleware.ts çerezi olmayanı zaten
  // sunucuda çeviriyor; bu, çerezi olup da oturumu geçersiz olan durumu
  // (süresi dolmuş / silinmiş oturum) kapatır.
  const [sessionState, setSessionState] = useState<"loading" | "ready">("loading");

  const reloadDomains = useCallback(async () => {
    const result = await api.listDomains();
    setDomains(result.domains);
    setDomainsError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [me, domainList] = await Promise.all([api.me(), api.listDomains()]);
        if (cancelled) return;
        setUser(me.user);
        setDomains(domainList.domains);
        setSessionState("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // "loading" halinde bırakıyoruz: yönlendirme tamamlanana kadar
          // içerik çizilmesin.
          router.replace("/login");
          return;
        }
        setDomainsError(err instanceof ApiError ? err.message : "Domain listesi alınamadı.");
        // Oturum geçerli ama domain listesi alınamadı olabilir; kabuk yine de
        // açılır, hata Note olarak sayfada görünür.
        setSessionState("ready");
      }

    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Sağlık durumu tek seferlik değildir: API/DB toparlandığında sayfayı elle
  // yenilemeden üst çubuk yeniden normale döner.
  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const health = await api.health();
        if (!cancelled) setDbState(health.db === "connected" ? "ok" : "err");
      } catch {
        if (!cancelled) setDbState("err");
      }
    }

    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkHealth();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", checkHealth);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", checkHealth);
    };
  }, []);

  // Sayfa değişince mobil çekmece kapansın.
  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      router.replace("/login");
    }
  }

  // Oturum doğrulanmadan hiçbir panel içeriği çizilmez.
  if (sessionState === "loading") {
    return (
      <div className="sp-boot" role="status" aria-live="polite">
        <span className="sp-boot-spinner" aria-hidden="true" />
        <span className="sp-boot-text">Oturum doğrulanıyor</span>
      </div>
    );
  }

  return (
    <ShellContext.Provider value={{ user, domains, domainsError, reloadDomains }}>
      <div className="sp-shell">
        <Sidebar pathname={pathname} domainCount={domains?.length ?? null} dbState={dbState} />

        {drawerOpen && (
          <>
            <div className="sp-drawer-backdrop" onClick={() => setDrawerOpen(false)} />
            <div className="sp-drawer" role="dialog" aria-modal="true" aria-label="Menü">
              <SidebarContent
                pathname={pathname}
                domainCount={domains?.length ?? null}
                dbState={dbState}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
          </>
        )}

        <div className="sp-main">
          <Topbar
            user={user}
            domains={domains}
            dbState={dbState}
            onOpenMenu={() => setDrawerOpen(true)}
            onLogout={logout}
          />
          <main className="sp-content">{children}</main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}

/** Sayfa başlığı. İçeriğin ilk elemanı olarak sayfanın kendisi render eder. */
export function PageHeader({
  title,
  breadcrumb,
  actions,
}: {
  title: ReactNode;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="sp-page-head">
      <div style={{ minWidth: 0 }}>
        {breadcrumb && <div className="sp-crumb">{breadcrumb}</div>}
        <h1 className="sp-page-title">{title}</h1>
      </div>
      {actions && <div className="sp-page-actions">{actions}</div>}
    </div>
  );
}
