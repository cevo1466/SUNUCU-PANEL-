"use client";

import { useCallback, useEffect, useState } from "react";
import { LockClosedIcon, LockOpenIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type SslCertDetails, type SslInfo } from "@/lib/api";
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

/** Tarayıcıda dosya olarak indirir (CSR için). */
function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-pem-file" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const EMPTY_CSR = {
  commonName: "",
  sans: "",
  organization: "",
  unit: "",
  country: "TR",
  state: "",
  city: "",
  email: "",
  keyType: "rsa2048" as "rsa2048" | "rsa4096" | "ec256",
};

export function SslManager({ domainId, onChange }: { domainId: number; onChange?: () => void }) {
  const toast = useToast();
  const [ssl, setSsl] = useState<SslInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  /** Sertifika alındı ama www/webmail eksik kaldıysa kalıcı uyarı. */
  const [gapNote, setGapNote] = useState<string | null>(null);

  // --- Ücretli (ticari) CA sertifikası: CSR + CRT/CA yükleme ---
  const [details, setDetails] = useState<SslCertDetails | null>(null);
  const [csrOpen, setCsrOpen] = useState(false);
  const [csrForm, setCsrForm] = useState(EMPTY_CSR);
  const [csrBusy, setCsrBusy] = useState(false);
  const [csrText, setCsrText] = useState<string | null>(null);
  const [csrError, setCsrError] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [certText, setCertText] = useState("");
  const [chainText, setChainText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState("");
  const [removing, setRemoving] = useState(false);

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

  const loadDetails = useCallback(async () => {
    try {
      const result = await api.sslDetails(domainId);
      setDetails(result.details);
    } catch {
      // Ayrıntılar yardımcı bilgidir; okunamazsa ana SSL kartı yine çalışır.
      setDetails(null);
    }
  }, [domainId]);

  useEffect(() => {
    void load();
    void loadDetails();
  }, [load, loadDetails]);

  const isCustom = ssl?.ssl_type === "custom";

  function openCsr() {
    setCsrError(null);
    setCsrText(null);
    setCsrForm((prev) => ({ ...prev, commonName: prev.commonName || ssl?.domain_name || "" }));
    setCsrOpen(true);
  }

  async function createCsr() {
    setCsrBusy(true);
    setCsrError(null);
    try {
      const result = await api.createSslCsr(domainId, {
        ...csrForm,
        sans: csrForm.sans
          .split(/[\s,]+/)
          .map((v) => v.trim())
          .filter(Boolean),
      });
      setCsrText(result.csr);
      void loadDetails();
    } catch (err) {
      setCsrError(err instanceof ApiError ? err.message : "CSR oluşturulamadı.");
    } finally {
      setCsrBusy(false);
    }
  }

  async function readFileInto(file: File | undefined, set: (v: string) => void) {
    if (!file) return;
    if (file.size > 64 * 1024) {
      setInstallError(`${file.name} 64 KB sınırını aşıyor; bir sertifika dosyası değil.`);
      return;
    }
    set(await file.text());
  }

  async function installCustom() {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await api.installCustomSsl(domainId, {
        certificate: certText,
        chain: chainText,
        privateKey: keyText,
      });
      setSsl(result.ssl);
      setInstallOpen(false);
      setCertText("");
      setChainText("");
      setKeyText("");
      setLastError(null);
      setGapNote(null);
      onChange?.();
      void loadDetails();
      toast.ok(
        "Sertifika kuruldu",
        `${result.ssl.domain_name}${result.www ? `, www.${result.ssl.domain_name}` : ""} · ${result.ssl.ssl_issuer ?? "özel CA"} · bitiş ${formatDate(result.ssl.ssl_expiry)}`,
      );
    } catch (err) {
      // Sebep modalda KALIR: anahtar uyuşmazlığı, eksik CA paketi, yanlış alan adı...
      setInstallError(err instanceof ApiError ? err.message : "Sertifika kurulamadı.");
    } finally {
      setInstalling(false);
    }
  }

  async function removeCustom() {
    setRemoving(true);
    try {
      const result = await api.removeCustomSsl(domainId);
      setSsl(result.ssl);
      setRemoveOpen(false);
      setRemoveConfirm("");
      onChange?.();
      void loadDetails();
      toast.ok(
        "Özel sertifika kaldırıldı",
        result.fallback === "letsencrypt"
          ? "Domain Let's Encrypt sertifikasına döndü."
          : "Geri dönülecek Let's Encrypt sertifikası yoktu; domain düz HTTP olarak yayında.",
      );
    } catch (err) {
      toast.error("Kaldırılamadı", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setRemoving(false);
    }
  }

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
                    {isCustom
                      ? `Ücretli sertifika etkin${ssl.ssl_issuer ? ` (${ssl.ssl_issuer})` : ""}.`
                      : "Let's Encrypt sertifikası etkin."}{" "}
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
                  "Bu domain için sertifika kurulu değil. Ücretsiz Let's Encrypt alabilir veya ücretli bir CA'dan aldığınız sertifikayı yükleyebilirsiniz."
                )}
              </p>

              {lastError ? (
                <Note tone="err">{lastError}</Note>
              ) : isCustom ? (
                <Note tone="warn">
                  Bu sertifika otomatik yenilenmez. Bitişinden önce CA&apos;dan yenileyin, yeni bir CSR
                  oluşturup gelen sertifikayı buradan yükleyin. Bitişe 30, 14 ve 7 gün kala
                  Telegram&apos;dan uyarı gelir.
                </Note>
              ) : gapNote ? (
                <Note tone="warn">{gapNote}</Note>
              ) : (
                <Note>
                  Let&apos;s Encrypt tek sertifikayla üç adresi birden kapsar: alan adının kendisi,{" "}
                  <span className="sp-mono">www.</span> ve <span className="sp-mono">webmail.</span> — her
                  biri için A kaydı bu sunucuyu göstermeli ve 80 portundan erişilebilmelidir. HTTPS
                  kurulduktan sonra <span className="sp-mono">http</span>, <span className="sp-mono">www</span>{" "}
                  ve <span className="sp-mono">https://www</span> adreslerinin hepsi 301 ile ana adrese
                  yönlenir. Bitiş tarihi sertifikadan okunur ve 30 gün kala otomatik yenilenir.
                </Note>
              )}

              <div className="sp-row">
                {isCustom ? (
                  <Button variant="secondary" onClick={() => setRemoveOpen(true)}>
                    Özel sertifikayı kaldır
                  </Button>
                ) : (
                  <Button variant="primary" onClick={requestCertificate} loading={requesting}>
                    {requesting
                      ? "Sertifika kuruluyor…"
                      : ssl?.ssl_status
                        ? "Sertifikayı yenile"
                        : "Let's Encrypt sertifikası al ve kur"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHead
          title="Sertifika yönetimi"
          actions={
            details?.present ? (
              <Badge tone={details.type === "custom" ? "info" : "neutral"}>
                {details.type === "custom" ? "Ücretli CA" : "Let's Encrypt"}
              </Badge>
            ) : null
          }
        />
        <PanelBody>
          <div className="sp-stack">
            <p className="sp-hint">
              Ücretli bir CA&apos;dan (Sectigo, DigiCert, GlobalSign…) sertifika alacaksanız önce
              <strong> CSR oluşturun</strong>, CA&apos;ya gönderin; size ilettiği sertifikayı (CRT) ve CA
              paketini <strong>Sertifikayı yükle</strong> ile kurun. Özel anahtar sunucudan çıkmaz.
            </p>

            {details?.pendingCsr && !isCustom ? (
              <Note>
                Bu domain için oluşturulmuş bir CSR var ve CA&apos;dan gelen sertifika bekleniyor. CRT&apos;yi
                yüklediğinizde anahtar otomatik eşleşir.
              </Note>
            ) : null}

            {details?.present ? (
              <dl className="sp-kv">
                <dt>Konu</dt>
                <dd className="sp-mono">{details.subject}</dd>
                <dt>Veren</dt>
                <dd className="sp-mono">{details.issuer}</dd>
                <dt>Alternatif adlar</dt>
                <dd className="sp-mono">{details.sans.length ? details.sans.join(", ") : "—"}</dd>
                <dt>Geçerlilik</dt>
                <dd>
                  {details.notBefore ? formatDate(details.notBefore) : "—"} –{" "}
                  {details.notAfter ? formatDate(details.notAfter) : "—"}
                </dd>
                <dt>Anahtar</dt>
                <dd>
                  {details.keyAlgo ?? "—"}
                  {details.keyBits ? ` · ${details.keyBits} bit` : ""}
                  {details.chainLength ? ` · zincir: ${details.chainLength} sertifika` : ""}
                </dd>
                <dt>SHA-256</dt>
                <dd className="sp-mono">{details.fingerprint}</dd>
              </dl>
            ) : (
              <p className="sp-hint">Sertifika ayrıntısı yok.</p>
            )}

            <div className="sp-row">
              <Button variant="secondary" onClick={openCsr}>
                CSR oluştur
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setInstallError(null);
                  setInstallOpen(true);
                }}
              >
                Sertifikayı yükle (CRT / CA)
              </Button>
            </div>
          </div>
        </PanelBody>
      </Panel>

      <Modal
        open={csrOpen}
        onClose={() => setCsrOpen(false)}
        wide
        title="CSR oluştur"
        footer={
          csrText ? (
            <Button variant="primary" onClick={() => setCsrOpen(false)}>
              Kapat
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setCsrOpen(false)} disabled={csrBusy}>
                Vazgeç
              </Button>
              <Button variant="primary" onClick={createCsr} loading={csrBusy} disabled={!csrForm.commonName}>
                CSR oluştur
              </Button>
            </>
          )
        }
      >
        {csrText ? (
          <div className="sp-stack">
            <Note tone="ok">
              CSR hazır. Bunu CA&apos;nın sipariş ekranına yapıştırın. Eşleşen özel anahtar sunucuda
              saklandı; CA sertifikayı gönderince &quot;Sertifikayı yükle&quot;den kurun. Yeni bir CSR
              oluşturursanız eskisi için gelen sertifika artık eşleşmez.
            </Note>
            <textarea className="sp-textarea sp-mono" rows={12} readOnly value={csrText} onFocus={(e) => e.currentTarget.select()} />
            <div className="sp-row">
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(csrText).then(
                    () => toast.ok("Kopyalandı", "CSR panoya alındı."),
                    () => toast.error("Kopyalanamadı", "Metni elle seçip kopyalayın."),
                  );
                }}
              >
                Kopyala
              </Button>
              <Button variant="secondary" onClick={() => downloadText(`${csrForm.commonName.replace(/\*/g, "wildcard")}.csr`, csrText)}>
                .csr indir
              </Button>
            </div>
          </div>
        ) : (
          <div className="sp-stack">
            {csrError ? <Note tone="err">{csrError}</Note> : null}
            <Field label="Ortak ad (CN)" hint="Sertifikanın ana adı. Joker için *.ornek.com yazın.">
              <input className="sp-input" value={csrForm.commonName} onChange={(e) => setCsrForm({ ...csrForm, commonName: e.target.value })} />
            </Field>
            <Field label="Alternatif adlar (SAN)" hint="Boşluk veya virgülle ayırın. Ortak ad otomatik eklenir; www için www.ornek.com ekleyin.">
              <input className="sp-input" value={csrForm.sans} onChange={(e) => setCsrForm({ ...csrForm, sans: e.target.value })} placeholder={`www.${ssl?.domain_name ?? "ornek.com"}`} />
            </Field>
            <div className="sp-row">
              <Field label="Kurum">
                <input className="sp-input" value={csrForm.organization} onChange={(e) => setCsrForm({ ...csrForm, organization: e.target.value })} />
              </Field>
              <Field label="Birim">
                <input className="sp-input" value={csrForm.unit} onChange={(e) => setCsrForm({ ...csrForm, unit: e.target.value })} />
              </Field>
            </div>
            <div className="sp-row">
              <Field label="Ülke (2 harf)">
                <input className="sp-input" maxLength={2} value={csrForm.country} onChange={(e) => setCsrForm({ ...csrForm, country: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="İl">
                <input className="sp-input" value={csrForm.state} onChange={(e) => setCsrForm({ ...csrForm, state: e.target.value })} />
              </Field>
              <Field label="İlçe / Şehir">
                <input className="sp-input" value={csrForm.city} onChange={(e) => setCsrForm({ ...csrForm, city: e.target.value })} />
              </Field>
            </div>
            <div className="sp-row">
              <Field label="E-posta">
                <input className="sp-input" type="email" value={csrForm.email} onChange={(e) => setCsrForm({ ...csrForm, email: e.target.value })} />
              </Field>
              <Field label="Anahtar türü">
                <select className="sp-select" value={csrForm.keyType} onChange={(e) => setCsrForm({ ...csrForm, keyType: e.target.value as typeof csrForm.keyType })}>
                  <option value="rsa2048">RSA 2048 (önerilen)</option>
                  <option value="rsa4096">RSA 4096</option>
                  <option value="ec256">ECDSA P-256</option>
                </select>
              </Field>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        wide
        title="Sertifikayı yükle"
        footer={
          <>
            <Button variant="secondary" onClick={() => setInstallOpen(false)} disabled={installing}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={installCustom} loading={installing} disabled={!certText.trim()}>
              Sertifikayı kur
            </Button>
          </>
        }
      >
        <div className="sp-stack">
          {installError ? <Note tone="err">{installError}</Note> : null}
          <Field label="Sertifika (CRT)" hint="CA'nın gönderdiği alan adı sertifikası. Tam paket (CRT + CA) yapıştırırsanız gerisi zincir sayılır.">
            <textarea className="sp-textarea sp-mono" rows={7} value={certText} onChange={(e) => setCertText(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" spellCheck={false} />
          </Field>
          <input type="file" accept=".crt,.cer,.pem,.txt" aria-label="CRT dosyası seç" onChange={(e) => void readFileInto(e.target.files?.[0], setCertText)} />
          <Field label="CA paketi (ara sertifikalar)" hint="ca-bundle / intermediate. Eksikse tarayıcılar ve Cloudflare Full (strict) zincir hatası verir.">
            <textarea className="sp-textarea sp-mono" rows={5} value={chainText} onChange={(e) => setChainText(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" spellCheck={false} />
          </Field>
          <input type="file" accept=".crt,.cer,.pem,.txt,.ca-bundle" aria-label="CA paketi dosyası seç" onChange={(e) => void readFileInto(e.target.files?.[0], setChainText)} />
          <Field label="Özel anahtar (isteğe bağlı)" hint="Bu panelde CSR oluşturduysanız BOŞ bırakın; anahtar otomatik eşleşir. CSR'ı başka yerde ürettiyseniz parolasız PEM anahtarı buraya yapıştırın.">
            <textarea className="sp-textarea sp-mono" rows={4} value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" spellCheck={false} autoComplete="off" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title="Özel sertifikayı kaldır"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoveOpen(false)} disabled={removing}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={removeCustom} loading={removing} disabled={removeConfirm !== ssl?.domain_name}>
              Kaldır
            </Button>
          </>
        }
      >
        <div className="sp-stack">
          <p className="sp-hint">
            Ücretli sertifika ve özel anahtarı sunucudan silinir. Domain varsa Let&apos;s Encrypt
            sertifikasına döner; yoksa düz HTTP olarak yayınlanır. Anahtarın bir kopyası sizde değilse
            bu işlem geri alınamaz.
          </p>
          <Field label={`Onaylamak için ${ssl?.domain_name ?? "alan adını"} yazın`}>
            <input className="sp-input" value={removeConfirm} onChange={(e) => setRemoveConfirm(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}
