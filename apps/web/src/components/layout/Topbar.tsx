"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRightStartOnRectangleIcon,
  Bars3Icon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import { NAV_ITEMS, type NavIcon } from "@/lib/nav";
import { StatusDot } from "@/components/ui/Bits";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import type { CurrentUser, Domain } from "@/lib/api";

interface Hit {
  href: string;
  label: string;
  note: string;
  icon: NavIcon;
}

/** Türkçe'ye duyarlı normalize: "İ"→"i", aksanları düşür. */
function normalize(value: string): string {
  return value
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function Topbar({
  user,
  domains,
  dbState,
  onOpenMenu,
  onLogout,
}: {
  user: CurrentUser | null;
  domains: Domain[] | null;
  dbState: "ok" | "err" | "idle";
  onOpenMenu: () => void;
  onLogout: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const hits = useMemo<Hit[]>(() => {
    const needle = normalize(query.trim());
    if (!needle) return [];

    const pages: Hit[] = NAV_ITEMS.filter(
      (item) =>
        normalize(item.label).includes(needle) ||
        item.keywords.some((keyword) => normalize(keyword).includes(needle)),
    ).map((item) => ({ href: item.href, label: item.label, note: "Sayfa", icon: item.icon }));

    const domainHits: Hit[] = (domains ?? [])
      .filter((domain) => normalize(domain.domain_name).includes(needle))
      .map((domain) => ({
        href: `/domains/${domain.id}`,
        label: domain.domain_name,
        note: "Domain",
        icon: GlobeAltIcon,
      }));

    return [...domainHits, ...pages].slice(0, 8);
  }, [query, domains]);

  useEffect(() => setCursor(0), [query]);

  // Ctrl/⌘+K aramayı odaklar. Rozet sahte değil, gerçekten bu tuşa bağlı.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Dışarı tıklayınca sonuç listesi kapansın.
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function go(hit: Hit) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(hit.href);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!hits.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => (c + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (c - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(hits[cursor]);
    }
  }

  const showResults = open && query.trim().length > 0;

  return (
    <header className="sp-topbar">
      <button className="sp-topbar-menu" onClick={onOpenMenu} aria-label="Menüyü aç">
        <Bars3Icon aria-hidden="true" />
      </button>

      <div className="sp-search" ref={wrapRef}>
        <div className="sp-search-box">
          <MagnifyingGlassIcon aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Domain veya sayfa ara"
            aria-label="Panelde ara"
            aria-expanded={showResults}
            aria-controls="sp-search-results"
            role="combobox"
            aria-autocomplete="list"
            autoComplete="off"
          />
          <kbd className="sp-search-hint">Ctrl K</kbd>
        </div>

        {showResults && (
          <div className="sp-search-results" id="sp-search-results" role="listbox">
            {hits.length === 0 ? (
              <p className="sp-search-empty">
                “{query}” için sonuç yok. Domain adının tamamını veya bir servis adını deneyin.
              </p>
            ) : (
              hits.map((hit, index) => (
                <button
                  key={`${hit.href}-${hit.label}`}
                  role="option"
                  aria-selected={index === cursor}
                  data-active={index === cursor}
                  className="sp-search-result"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => go(hit)}
                >
                  <hit.icon aria-hidden="true" />
                  <span>{hit.label}</span>
                  <small>{hit.note}</small>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="sp-topbar-right">
        <span className="sp-health">
          <StatusDot state={dbState} />
          {dbState === "ok" ? "Servisler çalışıyor" : dbState === "err" ? "Servis hatası" : "Kontrol ediliyor"}
        </span>
        <ThemeToggle />
        <div className="sp-user">
          <span className="sp-avatar" aria-hidden="true">
            {user?.username?.slice(0, 2).toLocaleUpperCase("tr") ?? "··"}
          </span>
          <span className="sp-user-name" title={user?.email}>
            {user?.username ?? "…"}
          </span>
          <Button variant="ghost" size="icon" onClick={onLogout} aria-label="Çıkış yap" title="Çıkış yap">
            <ArrowRightStartOnRectangleIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </header>
  );
}
