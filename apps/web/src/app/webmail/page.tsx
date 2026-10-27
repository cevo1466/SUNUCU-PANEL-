"use client";

import { useEffect, useState } from "react";
import { webmailApi } from "@/lib/webmail-api";
import { WebmailLogin } from "./WebmailLogin";
import { WebmailApp } from "./WebmailApp";

/**
 * Webmail giriş noktası.
 *
 * Oturum kontrolü İSTEMCİDE yapılıyor, panelin `middleware.ts`'i gibi sunucuda
 * değil: webmail çerezi panel çerezinden ayrı ve middleware'in tek işi panel
 * oturumunu korumak. `/webmail` o matcher'ın DIŞINDA tutuldu (bkz.
 * middleware.ts) — aksi halde posta kutusu sahibi panelin giriş ekranına
 * atılırdı.
 */
export default function WebmailPage() {
  const [address, setAddress] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    webmailApi
      .me()
      .then((data) => {
        if (!cancelled) setAddress(data.account?.address ?? null);
      })
      .catch(() => {
        if (!cancelled) setAddress(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    // Kısa ve sessiz: oturum kontrolü tek istek. Burada bir iskelet ekran
    // çizmek, çoğu durumda görünmeden kaybolan bir titreşim olurdu.
    return <div className="wm-boot" aria-busy="true" />;
  }

  return address ? (
    <WebmailApp address={address} onSignedOut={() => setAddress(null)} />
  ) : (
    <WebmailLogin onSignedIn={setAddress} />
  );
}
