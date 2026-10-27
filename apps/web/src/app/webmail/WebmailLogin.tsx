"use client";

import { useState, type FormEvent } from "react";
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { webmailApi, WebmailApiError } from "@/lib/webmail-api";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

/**
 * Webmail giriş ekranı.
 *
 * Panelin giriş ekranından KASITLI olarak ayrı duruyor: buraya giren kişi bir
 * panel yöneticisi değil, posta kutusu sahibi. Ekran tek bir işi anlatıyor —
 * "posta kutuna gir" — ve panele dair hiçbir şey (domain, sunucu, yönetim)
 * göstermiyor.
 */
export function WebmailLogin({ onSignedIn }: { onSignedIn: (address: string) => void }) {
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!address.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await webmailApi.login(address.trim(), password);
      onSignedIn(result.address);
    } catch (err) {
      setError(
        err instanceof WebmailApiError ? err.message : "Giriş yapılamadı. Bağlantınızı kontrol edin.",
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wm-auth">
      <div className="wm-auth-toolbar">
        <ThemeToggle />
      </div>

      <form className="wm-auth-card" onSubmit={submit}>
        <div className="wm-auth-brand">
          <EnvelopeIcon aria-hidden="true" />
          <div>
            <h1>Webmail</h1>
            <p>Posta kutunuza girin</p>
          </div>
        </div>

        <label className="wm-field">
          <span>E-posta adresi</span>
          <input
            className="sp-input sp-mono"
            type="email"
            autoComplete="username"
            inputMode="email"
            placeholder="info@alanadiniz.com"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="wm-field">
          <span>Parola</span>
          <input
            className="sp-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {/* Hata mesajı alanı, hata yokken de yer kaplamaz ama form zıplamasın
            diye kartın akışında duruyor. role=alert: ekran okuyucu duyurur. */}
        {error && (
          <p className="wm-auth-error" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" block loading={busy}>
          Giriş yap
        </Button>

        <p className="wm-auth-note">
          Adresinizin tamamını yazın. Parolanızı bilmiyorsanız alan adı yöneticinizden
          yenilemesini isteyin.
        </p>
      </form>
    </div>
  );
}
