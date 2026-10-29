"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ClipboardIcon,
  EnvelopeIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  api,
  ApiError,
  type MailAccount,
  type MailListResult,
  type MailServiceStatus,
} from "@/lib/api";
import { PASSWORD_HINT, passwordProblem } from "@studio-panel/shared";
import { formatBytes, formatDate } from "@/lib/format";
import { useShell } from "@/components/layout/AppShell";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Badge, EmptyState, Field, LoadingRow, Note } from "@/components/ui/Bits";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

/**
 * Domain başına e-posta hesapları.
 *
 * DÜRÜSTLÜK: Bu sunucuda Postfix/Dovecot kurulu değil. Panel hesap ve kota
 * tanımlarını yönetir ve Dovecot'un okuyacağı dosyayı üretir; e-posta
 * gönderilip alındığı iddia EDİLMEZ. Servis kapalıyken uyarı en üstte
 * gösterilir ve portların gerçek durumu kanıt olarak listelenir.
 *
 * YETKİ: Hesabı domain sahibi de açabilir; KOTAYI yalnızca yönetici belirler.
 * Buradaki `canSetQuota` sadece GÖRÜNÜM kararıdır — asıl kontrol sunucuda
 * `requireAdmin` ile yapılır (routes/mail.ts).
 */
/** apps/api/src/lib/mail.ts icindeki LOCAL_PART_PATTERN ile BIREBIR ayni. */
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
// Parola kurali TEK KAYNAKTAN: @studio-panel/shared. Burada ikinci bir
// kural listesi tutmak, sunucu ile arayuzun ayrisip birbirini yalanlamasi
// demekti (kullanici formda gecen bir parolanin sunucuda reddedildigini
// gorurdu ya da tersi).

/**
 * Tarayicida guvenli parola uretir.
 *
 * Karisabilecek karakterler (I l 1 O 0) DISARIDA: bu parola cogu zaman
 * telefonda okunuyor ve yanlis okunan tek karakter bir destek cagrisi demek.
 * Alfabe tam 64 karakter, 2^32 buna tam bolundugu icin modulo sapmasi yok.
 */
function makePassword(length = 16): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%*?-_";
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (n) => alphabet[n % alphabet.length]).join("");
}

/**
 * Formu GONDERMEDEN once dogrular.
 *
 * NEDEN TARAYICININ KENDI DOGRULAMASI YETMEDI: alanlarda `required` ve
 * `minLength={12}` vardi; kural saglanmayinca tarayici formu SESSIZCE
 * gondermiyordu. Gonder butonu diyalogun altbilgisinde, alan ise govdede
 * oldugu icin ortaya cikan baloncuk cogu zaman gorunmuyordu: kullanici
 * "Olustur"a basiyor, hicbir sey olmuyordu. Parolayi bosaltinca form geciyor
 * ama bu sefer sistem rastgele parola uretiyordu — yani "hicbir sey
 * tanimlayamiyorum, her seyi otomatik yapiyor" hissi. Kurallar artik alanin
 * altinda, Turkce ve gorunur.
 */
function validateCreate(localPart: string, password: string) {
  const errors: { localPart?: string; password?: string } = {};
  const normalized = localPart.trim().toLowerCase();
  if (!normalized) {
    errors.localPart = "Adresin @ öncesi kısmını yazın.";
  } else if (!LOCAL_PART_RE.test(normalized) || normalized.includes("..")) {
    errors.localPart =
      "Küçük harf, rakam, nokta, tire ve alt çizgi kullanılabilir; nokta veya tire ile başlayıp bitemez.";
  }
  // Parola BOS BIRAKILABILIR (sunucu uretir); yazildiysa kurala uymali.
  if (password) {
    const problem = passwordProblem(password);
    if (problem) errors.password = problem;
  }
  return errors;
}

export function MailManager({
  domainId,
  domainName,
  onCountChange,
}: {
  domainId: number;
  /** Formda adresin "@sonrasi" kismini gostermek icin. */
  domainName: string;
  onCountChange?: (count: number) => void;
}) {
  const toast = useToast();
  const { user } = useShell();
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [service, setService] = useState<MailServiceStatus | null>(null);
  const [suggested, setSuggested] = useState("info");
  const [defaultQuota, setDefaultQuota] = useState<number | null>(null);
  const [canSetQuota, setCanSetQuota] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [localPart, setLocalPart] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formErrors, setFormErrors] = useState<{ localPart?: string; password?: string }>({});
  const [quota, setQuota] = useState("");
  const [revealed, setRevealed] = useState<{ address: string; password: string; title: string } | null>(
    null,
  );
  const [quotaEditing, setQuotaEditing] = useState<MailAccount | null>(null);
  const [quotaValue, setQuotaValue] = useState("");
  const [passwordEditing, setPasswordEditing] = useState<MailAccount | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const [defaultValue, setDefaultValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<MailAccount | null>(null);
  const [webmail, setWebmail] = useState<{ url: string; https: boolean } | null>(null);
  const [dns, setDns] = useState<MailListResult["dns"] | null>(null);
  const [dnsFixing, setDnsFixing] = useState(false);

  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    try {
      const result = await api.listMailAccounts(domainId);
      setAccounts(result.accounts);
      setService(result.service);
      setSuggested(result.suggestedLocalPart);
      setDefaultQuota(result.defaultQuotaMb);
      setCanSetQuota(result.canSetQuota);
      setWebmail(result.webmail);
      setDns(result.dns);
      onCountChange?.(result.accounts.length);
    } catch (error) {
      setAccounts([]);
      toast.error(
        "E-posta hesapları alınamadı",
        error instanceof ApiError ? error.message : "Sunucuya ulaşılamadı.",
      );
    }
  }, [domainId, toast, onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const found = validateCreate(localPart, password);
    setFormErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const result = await api.createMailAccount(domainId, {
        // Sunucu da normalize ediyor; burada da yapiyoruz ki kullanici
        // gonderdigi degerin aynisini geri gorsun.
        localPart: localPart.trim().toLowerCase(),
        ...(password ? { password } : {}),
        // Kota alanı yalnızca yöneticide gönderilir; müşteri gönderirse
        // sunucu 403 döndürür (sessizce yok saymaz).
        ...(canSetQuota && quota ? { quotaMb: Number(quota) } : {}),
      });
      setCreateOpen(false);
      setLocalPart("");
      setPassword("");
      setShowPassword(false);
      setFormErrors({});
      setQuota("");
      setRevealed({ address: result.account.address, password: result.password, title: "E-posta hesabı hazır" });
      await load();
      toast.ok("E-posta hesabı oluşturuldu", result.account.address);
    } catch (error) {
      toast.error(
        "E-posta hesabı oluşturulamadı",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function fixDns() {
    setDnsFixing(true);
    try {
      const result = await api.fixMailDns(domainId);
      setDns(result.dns);
      if (result.unavailable) {
        toast.error("DNS kayıtları yazılamadı", result.unavailable);
      } else if (result.failed.length > 0) {
        toast.error(
          `${result.created} kayıt yazıldı, ${result.failed.length} tanesi yazılamadı`,
          result.failed.map((item) => `${item.name}: ${item.error}`).join(" · "),
        );
      } else if (result.created > 0) {
        // DNS yayilimi saniyeler surer; "tamam" demeden once beklemek yerine
        // durumu oldugu gibi gosteriyoruz — kullanici Yenile ile bakar.
        toast.ok(`${result.created} DNS kaydı oluşturuldu`, "Yayılması birkaç dakika sürebilir.");
      } else {
        toast.ok("Eksik kayıt yok", "Posta DNS kayıtlarının tamamı yerinde.");
      }
      // DEVRALINAN KAYITLAR GIZLENMEZ. Panel eski saglayicinin posta kaydini
      // kaldirdiysa kullanici bunu NE OLDUGUYLA birlikte gormeli — DNS'te
      // sessizce silme yapan bir arac guvenilmezdir.
      if (result.removed.length > 0) {
        toast.info(
          `${result.removed.length} eski kayıt devralındı`,
          `Kaldırılan: ${result.removed.join(" · ")}`,
        );
      }
      // Kaldirilmayanlar (web kayitlari) yalnizca bildirilir: orada calisan
      // bir site olabilir, silme karari kullanicinindir.
      for (const warning of result.warnings) {
        toast.info("Dikkat: eski kayıt duruyor", warning);
      }
      await load();
    } catch (error) {
      toast.error(
        "DNS kayıtları yazılamadı",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setDnsFixing(false);
    }
  }

  async function toggle(account: MailAccount) {
    try {
      await api.updateMailAccount(domainId, account.id, { enabled: !account.enabled });
      await load();
      toast.ok(account.enabled ? "Hesap durduruldu" : "Hesap etkinleştirildi", account.address);
    } catch (error) {
      toast.error(
        "Hesap güncellenemedi",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    }
  }

  async function remove(account: MailAccount) {
    try {
      await api.deleteMailAccount(domainId, account.id);
      await load();
      toast.ok("E-posta hesabı silindi", account.address);
    } catch (error) {
      toast.error(
        "Hesap silinemedi",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    }
  }

  async function saveQuota(event: FormEvent) {
    event.preventDefault();
    if (!quotaEditing) return;
    setBusy(true);
    try {
      await api.setMailQuota(domainId, quotaEditing.id, quotaValue ? Number(quotaValue) : null);
      setQuotaEditing(null);
      await load();
      toast.ok("Kota güncellendi", quotaEditing.address);
    } catch (error) {
      toast.error(
        "Kota güncellenemedi",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (!passwordEditing) return;
    // Bos birakilamaz — bos govdeli PATCH `enabled` disinda hicbir seyi
    // degistirmez ve kullanici "kaydettim" saniki halde sifre AYNI kalir.
    if (!newPassword) {
      setPasswordError("Yeni parolayı yazın veya üretin.");
      return;
    }
    const problem = passwordProblem(newPassword);
    if (problem) {
      setPasswordError(problem);
      return;
    }
    setBusy(true);
    try {
      const result = await api.updateMailAccount(domainId, passwordEditing.id, {
        password: newPassword,
      });
      const address = passwordEditing.address;
      setPasswordEditing(null);
      setNewPassword("");
      setShowNewPassword(false);
      setPasswordError(undefined);
      await load();
      // AYNI "bir kez goster" deseni: yeni parola olusturma akisindaki
      // `revealed` modaliyla paylasilir — iki farkli "parolani kaydet" akisi
      // tutmak, biri unutulup digeri guncellenince sessizce ayrisirdi.
      setRevealed({ address, password: result.password ?? newPassword, title: "Parola değişti" });
      toast.ok("Parola değiştirildi", address);
    } catch (error) {
      toast.error(
        "Parola değiştirilemedi",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveDefaultQuota(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.setMailQuotaDefault(
        domainId,
        defaultValue ? Number(defaultValue) : null,
      );
      setDefaultQuota(result.defaultQuotaMb);
      setDefaultOpen(false);
      toast.ok("Varsayılan kota kaydedildi");
    } catch (error) {
      toast.error(
        "Varsayılan kota kaydedilemedi",
        error instanceof ApiError ? error.message : "İşlem tamamlanmadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel>
        <PanelHead
          title={
            <>
              <EnvelopeIcon aria-hidden="true" />
              E-posta hesapları
            </>
          }
          actions={
            <>
              {/* Webmail'e giris: alan adi bazli (webmail.<domain>). Sema
                  sunucudan geliyor — HTTPS ancak o ad icin sertifika gercekten
                  yayindaysa kullanilir, aksi halde kullaniciyi tarayici
                  guvenlik uyarisina gondermis olurduk. */}
              {webmail && (
                <a
                  className="sp-btn sp-btn--secondary sp-btn--sm"
                  href={webmail.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={
                    webmail.https
                      ? `${webmail.url} — HTTPS yayında`
                      : `${webmail.url} — bu adres için henüz sertifika alınmadı (ops/scripts/webmail-ssl.sh)`
                  }
                >
                  <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  Webmail&apos;i aç
                </a>
              )}
              {isAdmin && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setDefaultValue(defaultQuota === null ? "" : String(defaultQuota));
                    setDefaultOpen(true);
                  }}
                >
                  Varsayılan kota
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  // ONCEDEN DOLDURMUYORUZ. Alan "info" ile dolu acilinca
                  // kullanici kendi adini yazmasi gerektigini fark etmiyor ve
                  // panel adi kendisi seciyormus gibi gorunuyordu. Oneri artik
                  // yer tutucu olarak duruyor: gorunur ama sizin degeriniz degil.
                  setLocalPart("");
                  setPassword("");
                  setShowPassword(false);
                  setFormErrors({});
                  setCreateOpen(true);
                }}
              >
                <PlusIcon aria-hidden="true" />
                Hesap oluştur
              </Button>
            </>
          }
        />
        {/*
          POSTA DNS'I — postanin calisip calismadigini belirleyen asil sey.
          Hesap acmak tek basina yetmiyor: MX yoksa disaridan posta gelmez,
          SPF/DKIM/DMARC yoksa giden posta "gonderen dogrulanamadi" damgasi
          yer. Kullanici bunu Hotmail'de gorene kadar panelde hicbir isaret
          yoktu (2026-09-02). Durum DNS'ten OLCULUYOR, panelin kaydindan
          degil.
        */}
        {dns && !dns.complete && (
          <div style={{ padding: "12px 14px 0" }}>
            <Note tone="warn">
              <strong>Posta DNS kayıtlarından {dns.missing} tanesi eksik.</strong> Bu hâliyle
              dışarıdan gelen posta teslim edilemez ve gönderdiğiniz postalar &quot;gönderen
              doğrulanamadı&quot; uyarısı alır.
              <div className="sp-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {dns.entries.map((entry) => (
                  <Badge
                    key={entry.kind}
                    tone={entry.state === "var" ? "ok" : entry.state === "eksik" ? "err" : "warn"}
                  >
                    {entry.label}: {entry.state === "var" ? "var" : entry.state === "eksik" ? "eksik" : "bakılamadı"}
                  </Badge>
                ))}
              </div>
              <div style={{ marginTop: 8 }}>
                <Button size="sm" variant="primary" onClick={fixDns} loading={dnsFixing}>
                  Eksik kayıtları oluştur
                </Button>
              </div>
            </Note>
          </div>
        )}
        {dns && dns.complete && (
          <div style={{ padding: "12px 14px 0" }}>
            <div className="sp-row" style={{ gap: 6, flexWrap: "wrap" }}>
              {dns.entries.map((entry) => (
                <Badge key={entry.kind} tone="ok">
                  {entry.label}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {service && !service.running && (
          <div style={{ padding: "12px 14px 0" }}>
            <Note tone="warn">
              {service.note} Hesaplar ve kotalar burada kayıtlı tutulur; Postfix/Dovecot kurulup
              panelin ürettiği kullanıcı dosyasına bağlanınca kullanılabilir hale gelir.{" "}
              <strong>Kota değerleri de o zamana kadar uygulanmaz.</strong>
            </Note>
            {/* İddianın kanıtı: portların gerçek durumu. */}
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 8,
                fontSize: 12,
                color: "var(--sp-ink-muted)",
              }}
            >
              {service.ports.map((port) => (
                <span key={port.port} className="sp-mono">
                  {port.label} {port.port}: {port.open ? "açık" : "kapalı"}
                </span>
              ))}
              <span className="sp-mono">kullanıcı dosyası: {service.usersFile}</span>
            </div>
          </div>
        )}
        <PanelBody flush>
          {accounts === null ? (
            <LoadingRow label="E-posta hesapları okunuyor" />
          ) : accounts.length === 0 ? (
            <EmptyState
              icon={EnvelopeIcon}
              title="Henüz e-posta hesabı yok"
              text="Bu domain için ilk posta kutusunu oluşturun."
            />
          ) : (
            <ul className="sp-mailbox-list">
              {accounts.map((account) => {
                // Doluluk: kota YOKSA cubuk cizilmez ("sinirsiz"), olculemediyse
                // "olculemedi" yazar. Sifir gibi gostermek yanlis guven verirdi.
                const quotaBytes = account.quota_mb === null ? null : account.quota_mb * 1024 * 1024;
                const used = account.used_bytes;
                const percent =
                  quotaBytes && used !== null ? Math.min(100, (used / quotaBytes) * 100) : null;
                const state = percent === null ? "ok" : percent >= 90 ? "err" : percent >= 75 ? "warn" : "ok";
                const initials = account.local_part.slice(0, 2).toLocaleUpperCase("tr");

                return (
                  <li key={account.id} className="sp-mailbox" data-disabled={!account.enabled}>
                    <span className="sp-mailbox-avatar" aria-hidden="true">
                      {initials}
                    </span>

                    <div className="sp-mailbox-main">
                      <div className="sp-mailbox-top">
                        <span className="sp-mailbox-address sp-mono">{account.address}</span>
                        {!account.enabled && <Badge tone="neutral">Kapalı</Badge>}
                      </div>

                      {/* DOLULUK — Plesk'in posta kutusu satirindaki asil bilgi.
                          Renk TEK BASINA anlam tasimaz; yaninda hep sayi var. */}
                      <div className="sp-mailbox-usage" data-state={state}>
                        {quotaBytes !== null && used !== null && (
                          <span className="sp-mailbox-bar">
                            <span className="sp-mailbox-fill" style={{ width: `${percent}%` }} />
                          </span>
                        )}
                        <span className="sp-mailbox-numbers sp-mono">
                          {used === null
                            ? account.usage_error
                              ? "kullanım ölçülemedi"
                              : "kullanım bilinmiyor"
                            : quotaBytes === null
                              ? `${formatBytes(used)} · kota sınırsız`
                              : `${formatBytes(used)} / ${formatBytes(quotaBytes)} (%${Math.round(percent!)})`}
                        </span>
                        <span className="sp-mailbox-created">{formatDate(account.created_at)}</span>
                      </div>
                    </div>

                    <div className="sp-mailbox-actions">
                      {/* Hesap basina webmail — Plesk'te de her posta kutusunun
                          yaninda kendi kutusuna giden bir baglanti var. */}
                      {webmail && (
                        <a
                          className="sp-btn sp-btn--ghost sp-btn--sm"
                          href={webmail.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={`${account.address} kutusuna gir`}
                        >
                          <ArrowTopRightOnSquareIcon aria-hidden="true" />
                          Webmail
                        </a>
                      )}
                      {canSetQuota && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setQuotaEditing(account);
                            setQuotaValue(account.quota_mb === null ? "" : String(account.quota_mb));
                          }}
                        >
                          Kota
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setPasswordEditing(account);
                          setNewPassword("");
                          setShowNewPassword(false);
                          setPasswordError(undefined);
                        }}
                      >
                        <KeyIcon aria-hidden="true" />
                        Şifre
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void toggle(account)}>
                        {account.enabled ? "Durdur" : "Etkinleştir"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`${account.address} hesabını sil`}
                        title={`${account.address} hesabını sil`}
                        onClick={() => setDeleting(account)}
                      >
                        <TrashIcon aria-hidden="true" />
                        Sil
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </PanelBody>
      </Panel>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="E-posta hesabı oluştur"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>
              Vazgeç
            </Button>
            <Button variant="primary" type="submit" form="mail-create-form" loading={busy}>
              Oluştur
            </Button>
          </>
        }
      >
        <form id="mail-create-form" className="sp-stack" onSubmit={create}>
          <Field
            label="Adresin @ öncesi kısmı"
            hint={`Küçük harf, rakam, nokta, tire ve alt çizgi. Büyük harf girerseniz küçüğe çevrilir. Öneri: ${suggested}`}
            error={formErrors.localPart}
          >
            <div className="sp-input-affix">
              <input
                className="sp-input sp-mono"
                // `required` YOK: kural sağlanmayınca tarayıcı formu sessizce
                // gönderemez hale getiriyordu ve sebep görünmüyordu. Doğrulama
                // artık validateCreate() ile yapılıp alanın altında yazıyor.
                placeholder={suggested}
                autoComplete="off"
                spellCheck={false}
                value={localPart}
                onChange={(event) => {
                  setLocalPart(event.target.value);
                  if (formErrors.localPart) setFormErrors((prev) => ({ ...prev, localPart: undefined }));
                }}
              />
              <span className="sp-input-suffix sp-mono">@{domainName}</span>
            </div>
          </Field>
          <Field
            label="Parola"
            hint={`${PASSWORD_HINT} Boş bırakırsanız güvenli bir parola üretilir ve yalnızca bir kez gösterilir.`}
            error={formErrors.password}
          >
            <div className="sp-row" style={{ gap: 6, alignItems: "stretch" }}>
              <input
                className="sp-input"
                style={{ flex: 1, minWidth: 0 }}
                // minLength YOK — bkz. validateCreate() açıklaması.
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (formErrors.password) setFormErrors((prev) => ({ ...prev, password: undefined }));
                }}
              />
              <Button
                // type="button" ZORUNLU: form içindeki butonlar varsayılan
                // olarak submit'tir, bu buton formu göndermemeli.
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Parolayı gizle" : "Parolayı göster"}
                title={showPassword ? "Parolayı gizle" : "Parolayı göster"}
              >
                {showPassword ? <EyeSlashIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPassword(makePassword());
                  setShowPassword(true);
                  setFormErrors((prev) => ({ ...prev, password: undefined }));
                }}
              >
                <ArrowPathIcon aria-hidden="true" />
                Üret
              </Button>
            </div>
          </Field>
          {canSetQuota ? (
            <Field label="Kota (MB)" hint="Boş bırakırsanız domain varsayılanı uygulanır.">
              <input
                className="sp-input"
                type="number"
                min={10}
                max={1048576}
                value={quota}
                onChange={(event) => setQuota(event.target.value)}
              />
            </Field>
          ) : (
            // Kota GİZLENMEZ, salt-okunur gösterilir: müşteri ne kadar kotası
            // olduğunu bilmeli ama değiştirememeli. Gizlemek "kota diye bir şey
            // yok" izlenimi verirdi.
            <Note>
              {defaultQuota === null
                ? "Kota: yönetici henüz bir sınır belirlemedi."
                : `Kota: ${defaultQuota} MB — yöneticinin belirlediği varsayılan uygulanır.`}
            </Note>
          )}
        </form>
      </Modal>

      <Modal
        open={quotaEditing !== null}
        onClose={() => setQuotaEditing(null)}
        title="Kotayı değiştir"
        footer={
          <>
            <Button variant="secondary" onClick={() => setQuotaEditing(null)} disabled={busy}>
              Vazgeç
            </Button>
            <Button variant="primary" type="submit" form="mail-quota-form" loading={busy}>
              Kaydet
            </Button>
          </>
        }
      >
        <form id="mail-quota-form" className="sp-stack" onSubmit={saveQuota}>
          <Field
            label={`Kota (MB) — ${quotaEditing?.address ?? ""}`}
            hint="Boş bırakırsanız sınırsız olur."
          >
            <input
              className="sp-input"
              type="number"
              min={10}
              max={1048576}
              value={quotaValue}
              onChange={(event) => setQuotaValue(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={passwordEditing !== null}
        onClose={() => setPasswordEditing(null)}
        title="Şifreyi değiştir"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPasswordEditing(null)} disabled={busy}>
              Vazgeç
            </Button>
            <Button variant="primary" type="submit" form="mail-password-form" loading={busy}>
              Kaydet
            </Button>
          </>
        }
      >
        <form id="mail-password-form" className="sp-stack" onSubmit={savePassword}>
          <Note tone="warn">
            {passwordEditing?.address} için yeni parola belirleniyor. Eski parola bu andan itibaren
            çalışmaz; webmail ve posta istemcilerinde yeni parola girilmesi gerekir.
          </Note>
          <Field
            label="Yeni parola"
            hint={PASSWORD_HINT}
            error={passwordError}
          >
            <div className="sp-row" style={{ gap: 6, alignItems: "stretch" }}>
              <input
                className="sp-input"
                style={{ flex: 1, minWidth: 0 }}
                type={showNewPassword ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  if (passwordError) setPasswordError(undefined);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setShowNewPassword((value) => !value)}
                aria-label={showNewPassword ? "Parolayı gizle" : "Parolayı göster"}
                title={showNewPassword ? "Parolayı gizle" : "Parolayı göster"}
              >
                {showNewPassword ? <EyeSlashIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setNewPassword(makePassword());
                  setShowNewPassword(true);
                  setPasswordError(undefined);
                }}
              >
                <ArrowPathIcon aria-hidden="true" />
                Üret
              </Button>
            </div>
          </Field>
        </form>
      </Modal>

      <Modal
        open={defaultOpen}
        onClose={() => setDefaultOpen(false)}
        title="Varsayılan kota"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDefaultOpen(false)} disabled={busy}>
              Vazgeç
            </Button>
            <Button variant="primary" type="submit" form="mail-default-form" loading={busy}>
              Kaydet
            </Button>
          </>
        }
      >
        <form id="mail-default-form" className="sp-stack" onSubmit={saveDefaultQuota}>
          <Note>
            Bu domainde yeni açılan hesaplara uygulanır. Müşteri kendi hesabını açtığında kota
            alanını göremez; buradaki değeri devralır.
          </Note>
          <Field label="Varsayılan kota (MB)" hint="Boş bırakırsanız 256 MB uygulanır.">
            <input
              className="sp-input"
              type="number"
              min={10}
              max={1048576}
              value={defaultValue}
              onChange={(event) => setDefaultValue(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title={revealed?.title ?? "E-posta hesabı hazır"}
        footer={
          <Button variant="primary" onClick={() => setRevealed(null)}>
            Parolayı kaydettim
          </Button>
        }
      >
        <div className="sp-stack">
          <Note tone="warn">
            Bu parola yalnızca şimdi gösterilir. Kapatmadan önce güvenli bir parola yöneticisine
            kaydedin.
          </Note>
          <div className="sp-row">
            <code className="sp-mono" style={{ flex: 1 }}>
              {revealed?.address}
            </code>
          </div>
          <div className="sp-row">
            <code className="sp-mono" style={{ flex: 1 }}>
              {revealed?.password}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void navigator.clipboard.writeText(revealed?.password ?? "")}
            >
              <ClipboardIcon aria-hidden="true" />
              Kopyala
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        title="E-posta hesabını sil"
        description={
          deleting
            ? `${deleting.address} posta kutusu panelden silinecek. Sunucudaki posta dosyaları (varsa) silinmez.`
            : ""
        }
        confirmLabel="Hesabı sil"
      />
    </>
  );
}
