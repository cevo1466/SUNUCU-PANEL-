"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleStackIcon } from "@heroicons/react/24/outline";
import { api, ApiError } from "@/lib/api";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button } from "@/components/ui/button";
import { Badge, Field, LoadingRow, Note } from "@/components/ui/Bits";
import { useToast } from "@/components/ui/Toast";

/**
 * Adminer, domain'e bağlı değil — sunucuda panel-geneli tek bir servis
 * olarak çalışır (bkz. ops/scripts/service.sh "adminer"). Bu yüzden bu ayar
 * domain seçiciden bağımsız, /databases sayfasının üstünde bir kez gösterilir.
 */
/**
 * `php84` gibi ham bir dosya adını okunur hale getirir: "PHP 8.4 (php84)".
 *
 * NEDEN: Alpine paketi aynı ikiliye üç ad bırakıyor — `php`, `php8.4`,
 * `php84` — ve listede bunlar olduğu gibi görünüyordu. Kullanıcı haklı
 * olarak "php84 ne demek" diye sordu: seçim kutusunda bir dosya adı
 * görmek, bir sürüm seçtiğini sanan kişiye hiçbir şey anlatmıyor.
 * Sürüm öne çıkarılıyor, dosya adı parantezde kanıt olarak kalıyor
 * (operatör sunucuda hangi ikilinin çalıştığını görebilmeli).
 */
export function phpBinaryLabel(binary: string): string {
  // "php84" -> 8.4 | "php8.4" -> 8.4 | "php" -> sürüm bilgisi yok
  const match = /^php(\d)\.?(\d+)$/.exec(binary);
  if (match) return `PHP ${match[1]}.${match[2]} (${binary})`;
  if (binary === "php") return `Sistem varsayılanı (${binary})`;
  return binary;
}

export function AdminerSettings() {
  const toast = useToast();
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [drivers, setDrivers] = useState<{ postgres: boolean; mysql: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.adminerStatus();
      setInstalled(result.installed);
      setAvailable(result.availablePhpBinaries);
      setSelected(result.selectedPhpBin ?? result.availablePhpBinaries[0] ?? "");
      setDrivers(result.drivers);
      setNote(result.note);
    } catch (err) {
      toast.error("Adminer durumu alınamadı", err instanceof ApiError ? err.message : "Sunucuya ulaşılamadı.");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      await api.setAdminerPhpVersion(selected);
      toast.ok("Kaydedildi", `Adminer "${selected}" ile yeniden başlatıldı.`);
      await load();
    } catch (err) {
      toast.error("Kaydedilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  if (installed === null) {
    return (
      <Panel>
        <PanelBody>
          <LoadingRow label="Adminer durumu okunuyor" />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead
        title={
          <>
            <CircleStackIcon aria-hidden="true" />
            Adminer
          </>
        }
      />
      <PanelBody>
        <div className="sp-stack">
          {!installed && (
            <Note tone="warn">
              Adminer henüz kurulu değil. Sunucuda{" "}
              <span className="sp-mono">sudo ops/scripts/install-adminer.sh</span> çalıştırıldıktan sonra
              buradan başlatabilirsiniz.
            </Note>
          )}

          {/*
            Sürücü durumu. Adminer'ın "kurulu" olması giriş yapılabileceği
            anlamına GELMEZ: PHP'de pgsql/mysqli eklentisi yoksa giriş formu
            açılır ama her deneme başarısız olur. Panel bunu artık gizlemiyor.
          */}
          {installed && note && <Note tone="warn">{note}</Note>}

          {installed && drivers && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Badge tone={drivers.postgres ? "ok" : "err"}>
                PostgreSQL sürücüsü: {drivers.postgres ? "var" : "yok"}
              </Badge>
              <Badge tone={drivers.mysql ? "ok" : "err"}>
                MySQL sürücüsü: {drivers.mysql ? "var" : "yok"}
              </Badge>
            </div>
          )}

          {/*
            "Neden veritabanları sayfasında PHP soruluyor?" — Adminer tek
            dosyalık bir PHP uygulaması ve panel onu PHP'nin kendi geliştirme
            sunucusuyla (`php -S`) çalıştırıyor. Yani buradaki seçim sitelerin
            PHP sürümüyle ilgili DEĞİL, yalnızca bu aracı hangi PHP ikilisinin
            başlatacağıyla ilgili. Etiket bunu söylemiyordu ve "php84" ham bir
            dosya adı olarak görünüp kafa karıştırıyordu (kullanıcı sordu,
            2026-09-02). Sitelerin PHP sürümü domain detayındaki Çalışma
            ortamı sekmesinde seçilir.
          */}
          <Field
            label="Adminer'ı başlatacak PHP çalıştırılabiliri"
            hint={
              available.length > 0
                ? "Adminer tek dosyalık bir PHP uygulamasıdır; panel onu `php -S` ile çalıştırır. Buradaki seçim sitelerinizin PHP sürümünü ETKİLEMEZ — o, domain detayındaki Çalışma ortamı sekmesindedir."
                : "Sunucuda çalıştırılabilir bir PHP bulunamadı (`sudo apk add php84` ile kurun). Adminer tek dosyalık bir PHP uygulamasıdır; onsuz başlatılamaz."
            }
          >
            {available.length > 0 ? (
              <select className="sp-input" value={selected} onChange={(event) => setSelected(event.target.value)}>
                {available.map((bin) => (
                  <option key={bin} value={bin}>
                    {phpBinaryLabel(bin)}
                  </option>
                ))}
              </select>
            ) : (
              <input className="sp-input sp-mono" value={selected} disabled placeholder="php8.4" />
            )}
          </Field>

          <div>
            <Button variant="primary" size="sm" onClick={save} loading={busy} disabled={!selected}>
              Kaydet ve yeniden başlat
            </Button>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}
