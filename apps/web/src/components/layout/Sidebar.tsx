"use client";

import Link from "next/link";
import { ServerStackIcon } from "@heroicons/react/24/outline";
import { NAV_GROUPS, isNavItemActive } from "@/lib/nav";
import { StatusDot } from "@/components/ui/Bits";

export function SidebarContent({
  pathname,
  domainCount,
  dbState,
  onNavigate,
}: {
  pathname: string;
  domainCount: number | null;
  /** /api/health sonucundan gelir; sabit "her şey yolunda" yazısı yok. */
  dbState: "ok" | "err" | "idle";
  onNavigate?: () => void;
}) {
  return (
    <>
      <Link href="/dashboard" className="sp-nav-brand" onClick={onNavigate}>
        <span className="sp-nav-brand-mark" aria-hidden="true">
          <ServerStackIcon />
        </span>
        <span className="sp-nav-brand-name">{process.env.NEXT_PUBLIC_PANEL_DISPLAY_NAME ?? "Studio Panel"}</span>
      </Link>

      <nav className="sp-nav-scroll" aria-label="Ana menü">
        {NAV_GROUPS.map((group) => (
          <div className="sp-nav-group" key={group.title}>
            <p className="sp-nav-group-title">{group.title}</p>
            {group.items.map((item) => {
              const active = isNavItemActive(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="sp-nav-item"
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                >
                  <item.icon aria-hidden="true" />
                  {item.label}
                  {item.href === "/domains" && domainCount !== null && (
                    <span className="sp-nav-count">{domainCount}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sp-nav-foot">
        <StatusDot state={dbState} />
        <span>
          {dbState === "ok"
            ? "Veritabanı bağlı"
            : dbState === "err"
              ? "Veritabanına ulaşılamıyor"
              : "Durum kontrol ediliyor"}
        </span>
      </div>
    </>
  );
}

export function Sidebar(props: Parameters<typeof SidebarContent>[0]) {
  return (
    <aside className="sp-nav">
      <SidebarContent {...props} />
    </aside>
  );
}
