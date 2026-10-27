"use client";

import { useCallback, useEffect, useState } from "react";
import { LockClosedIcon, LockOpenIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type SslInfo } from "@/lib/api";
import { formatDate, relativeDays } from "@/lib/format";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button } from "@/components/ui/button";
import { Badge, Field, LoadingRow, Note } from "@/components/ui/Bits";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

/** Bitiş tarihi 30 günden yakınsa uyarı, geçmişse hata. */
function sslTone(ssl: SslInfo | null): "ok" | "warn" | "err" | "neutral" {
  if (!ssl?.ssl_status) return "neutral";
  if (!ssl.ssl_expiry) return "ok";
  const daysLeft = (new Date(ssl.ssl_expiry).getTime() - Date.now()) / 86_400_000;
  if (daysLeft < 0) return "err";
  if (daysLeft < 30) return "warn";
  return "ok";
}

export function SslManager({ domainId, onChange }: { domainId: number; onChange?: () => void }) {
  const toast = useToast();
  const [ssl, setSsl] = useState<SslInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [marking, setMarking] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  /** Sertifika alındı ama www/webmail eksik kaldıysa kalıcı uyarı. */
  const [gapNote, setGapNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.sslStatus(domainId);
      setSsl(result.ssl);
    } catch (err) {
      toast.error("SSL durumu alınamadı", err instanceof ApiError ? err.message : "Sunucuya ulaşılamadı.");
    } finally {
      setLoading(false);
    }
  }, [domainId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function requestCertificate() {
    setRequesting(true);
    setLastError(null);
    setGapNote(null);
    try {
      // Certbot gerçekten çalışır: doğrulama + nginx reload dahil bir dakikayı
      // bulabilir. Buton bu süre boyunca "kuruluyor" durumunda kalır.
      const result = await api.requestSsl(domainId);
      setSsl(result.ssl);
      onChange?.();
      // Ne KURULDUGUNU tek tek soyler. "Sertifika kuruldu" tek basina, www
      // veya webmail eksik kaldiginda kullaniciyi yanlis bir tamamlanmislik
      // hissiyle birakiyordu.
      const covered = [result.ssl.domain_name];
      if (result.www) covered.push(`www.${result.ssl.domain_name}`);
      if (result.webmail === "kuruldu") covered.push(`webmail.${result.ssl.domain_name}`);
      toast.ok(
        "Sertifika kuruldu",
        `${covered.join(", ")} · bitiş ${formatDate(result.ssl.ssl_expiry)}`,
      );
      // Panel eksik DNS kayıtlarını kendisi açıyor; AÇAMADIYSA sebebini
      // söylüyor. "A kaydını siz ekleyin" demek, tek tıkla SSL vaadini yarım
      // bırakmaktı — ama açamadığımız durumu da gizlemiyoruz.
      const gaps: string[] = [];
      for (const entry of result.dns ?? []) {
        if (entry.outcome === "cloudflare-yok" || entry.outcome === "ip-yok") {
          gaps.push(`${entry.host} için A kaydı açılamadı: ${entry.detail ?? "sebep bilinmiyor"}`);
        } else if (entry.outcome === "yayilmadi") {
          gaps.push(`${entry.host} kaydı açıldı ama henüz yayılmadı; birkaç dakika sonra tekrar deneyin.`);
        } else if (entry.outcome === "hata") {
          gaps.push(`${entry.host} kaydı açılamadı: ${entry.detail ?? "hata"}`);
        }
      }
      if (!result.www) {
        gaps.push(`www.${result.ssl.domain_name} sertifikaya eklenemedi.`);
      }
      if (result.webmail === "basarisiz") {
        gaps.push(
          `webmail.${result.ssl.domain_name} sertifikası alınamadı — 80 portundan dışarıdan erişilebildiğini doğrulayın.`,
        );
      } else if (result.webmail === "dns-yok") {
        gaps.push(`webmail.${result.ssl.domain_name} hâlâ çözümlenmiyor; webmail HTTPS kurulamadı.`);
      }
      setGapNote(gaps.length > 0 ? gaps.join(" ") : null);
    } catch (err) {
      // Sebep panelde KALICI olarak gösterilir: toast kaybolur, hata mesajı
      // ise ne yapılacağını söylüyor (A kaydı, 80 portu, config eksik...).
      const reason = err instanceof ApiError ? err.message : "İşlem tamamlanmadı.";
      setLastError(reason);
      toast.error("Sertifika kurulamadı", reason);
    } finally {
      setRequesting(false);
    }
  }

  async function markIssued() {
    setMarking(true);
    try {
      // <input type="datetime-local"> yerel saat verir; API ISO bekliyor.
      const iso = new Date(expiresAt).toISOString();
      const result = await api.markSslIssued(domainId, iso);
      setSsl(result.ssl);
      setMarkOpen(false);
      onChange?.();
      toast.ok("Sertifika kaydedildi", `Bitiş: ${formatDate(result.ssl.ssl_expiry)}`);
    } catch (err) {
      toast.error(
        "Sertifika kaydedilemedi",
        err instanceof ApiError ? err.message : "Bitiş tarihi gelecekte bir tarih olmalı.",
      );
    } finally {
      setMarking(false);
    }
  }

  const tone = sslTone(ssl);
  const relative = relativeDays(ssl?.ssl_expiry);

  return (
    <>
      <Panel>
        <PanelHead
          title={
            <>
              {ssl?.ssl_status ? <LockClosedIcon aria-hidden="true" /> : <LockOpenIcon aria-hidden="true" />}
              SSL/TLS sertifikası
            </>
          }
          actions={
            ssl?.ssl_status ? (
              <Badge tone={tone === "neutral" ? "ok" : tone}>
                {tone === "err"
                  ? "Süresi doldu"
                  : tone === "warn"
                    ? "Yakında bitiyor"
                    : "Geçerli"}
              </Badge>
            ) : (
              <Badge tone="neutral">Sertifika yok</Badge>
            )
          }
        />

        <PanelBody>
          {loading ? (
            <LoadingRow label="SSL durumu okunuyor" />
          ) : (
            <div className="sp-stack">
              <p className="sp-hint">
                {ssl?.ssl_status ? (
                  <>
                    Sertifika etkin.{" "}
                    {ssl.ssl_expiry ? (
                      <>
                        Bitiş tarihi <strong>{formatDate(ssl.ssl_expiry)}</strong>
                        {relative && ` (${relative})`}.
                      </>
                    ) : (
                      "Bitiş tarihi kayıtlı değil."
                    )}
                  </>
                ) : (
                  "Bu domain için Let's Encrypt sertifikası alınmamış."
                )}
              </p>

              {lastError ? (
                <Note tone="err">{lastError}</Note>
              ) : gapNote ? (
                <Note tone="warn">{gapNote}</Note>
              ) : (
                <Note>
                  Tek sertifika üç adresi birden kapsar: alan adının kendisi,{" "}
                  <span className="sp-mono">www.</span> ve{" "}
                  <span className="sp-mono">webmail.</span> — her biri için A kaydı bu sunucuyu
                  göstermeli ve 80 portundan erişilebilmelidir. HTTPS kurulduktan sonra{" "}
                  <span className="sp-mono">http</span>, <span className="sp-mono">www</span> ve{" "}
                  <span className="sp-mono">https://www</span> adreslerinin hepsi 301 ile ana
                  adrese yönlenir. İşlem bir dakikayı bulabilir; bitiş tarihi sertifikadan okunur
                  ve 30 gün kala otomatik yenilenir.
                </Note>
              )}

              <div className="sp-row">
                <Button variant="primary" onClick={requestCertificate} loading={requesting}>
                  {requesting
                    ? "Sertifika kuruluyor…"
                    : ssl?.ssl_status
                      ? "Sertifikayı yenile"
                      : "Sertifikayı al ve kur"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    // Varsayılan: Let's Encrypt sertifikaları 90 gün geçerli.
                    const in90Days = new Date(Date.now() + 90 * 86_400_000);
                    in90Days.setSeconds(0, 0);
                    setExpiresAt(
                      new Date(in90Days.getTime() - in90Days.getTimezoneOffset() * 60_000)
                        .toISOString()
                        .slice(0, 16),
                    );
                    setMarkOpen(true);
                  }}
                >
                  Dışarıda alınan sertifikayı işaretle
                </Button>
              </div>
            </div>
          )}
        </PanelBody>
      </Panel>

      <Modal
        open={markOpen}
        onClose={() => setMarkOpen(false)}
        title="Sertifikayı alındı olarak işaretle"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMarkOpen(false)} disabled={marking}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={markIssued} loading={marking} disabled={!expiresAt}>
              Kaydet
            </Button>
          </>
        }
      >
        <div className="sp-stack">
          <p className="sp-hint">
            Bu form yalnızca panel dışında kurulmuş sertifikalar içindir. Panelden aldığınız
            sertifikalarda bitiş tarihi otomatik okunur, elle girmenize gerek yoktur.
          </p>
          <Field
            label="Sertifika bitiş tarihi"
            hint="Let's Encrypt sertifikaları alındıkları günden 90 gün sonra biter."
          >
            <input
              className="sp-input"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
