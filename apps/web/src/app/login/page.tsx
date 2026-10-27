"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ServerStackIcon } from "@heroicons/react/24/outline";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/Bits";

/**
 * Giriş sonrası gidilecek yol. middleware.ts, oturumsuz bir istek geldiğinde
 * hedefi `?next=` ile buraya taşır.
 *
 * `useSearchParams` yerine doğrudan `location.search` okunuyor: bu bileşen
 * yalnızca tarayıcıda çalışıyor ve kanca, sayfayı Suspense sınırına sokmayı
 * gerektirirdi.
 *
 * GÜVENLİK: yalnızca tek eğik çizgiyle başlayan panel içi yollar kabul edilir.
 * `//evil.com` ve `https://evil.com` gibi değerler açık yönlendirmeye
 * (open redirect) yol açardı; reddedilip panele düşülür.
 */
function nextPathFromQuery(): string {
  const fallback = "/dashboard";
  if (typeof window === "undefined") return fallback;
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api.login({ email, password });
      router.replace(nextPathFromQuery());
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "E-posta veya parola hatalı."
          : err instanceof ApiError
            ? err.message
            : "Panele ulaşılamadı. Sunucunun çalıştığını doğrulayın.",
      );
      setPending(false);
    }
  }

  return (
    <main className="sp-auth">
      <div className="sp-auth-card">
        <div className="sp-auth-head">
          <span className="sp-nav-brand-mark" aria-hidden="true">
            <ServerStackIcon />
          </span>
          <span className="sp-auth-title">{process.env.NEXT_PUBLIC_PANEL_DISPLAY_NAME ?? "Studio Panel"}</span>
        </div>

        <form className="sp-auth-body" onSubmit={onSubmit}>
          {error && (
            <p className="sp-note sp-note--warn" role="alert">
              {error}
            </p>
          )}

          <Field label="E-posta">
            <input
              className="sp-input"
              type="email"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
            />
          </Field>

          <Field label="Parola">
            <input
              className="sp-input"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>

          <Button type="submit" variant="primary" block loading={pending}>
            {pending ? "Giriş yapılıyor" : "Giriş yap"}
          </Button>
        </form>

        <p className="sp-auth-foot">Panel tek yönetici hesabıyla kullanılır.</p>
      </div>
    </main>
  );
}
