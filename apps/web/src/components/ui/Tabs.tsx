"use client";

import { useRef, type ComponentType, type SVGProps } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Sekme başlığında gösterilen sayaç (DNS kayıt adedi gibi). */
  count?: number;
}

/**
 * WAI-ARIA sekme deseni: ok tuşları sekmeler arasında gezinir, Home/End uçlara
 * gider. Seçili sekme URL'de `?tab=` olarak tutulduğu için sayfa yenilendiğinde
 * kaybolmaz — bunu çağıran sayfa yönetir.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: React.KeyboardEvent) {
    const index = tabs.findIndex((tab) => tab.id === active);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;

    event.preventDefault();
    onChange(tabs[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  return (
    <div className="sp-tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          className="sp-tab"
          onClick={() => onChange(tab.id)}
        >
          {tab.icon && <tab.icon aria-hidden="true" />}
          {tab.label}
          {typeof tab.count === "number" && <span className="sp-nav-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
}) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}
