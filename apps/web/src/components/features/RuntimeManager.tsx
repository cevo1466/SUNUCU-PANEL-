"use client";

import { useCallback, useEffect, useState } from "react";
import { CommandLineIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type DomainRuntime } from "@/lib/api";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button } from "@/components/ui/button";
import { Field, LoadingRow, Note } from "@/components/ui/Bits";
import { useToast } from "@/components/ui/Toast";

type RuntimeChoice = DomainRuntime["runtime_type"];

export function RuntimeManager({
  domainId,
  onChange,
}: {
  domainId: number;
  onChange?: () => void;
}) {
  const toast = useToast();
  const [runtime, setRuntime] = useState<DomainRuntime | null>(null);
  const [installedPhpVersions, setInstalledPhpVersions] = useState<string[]>([]);
  const [choice, setChoice] = useState<RuntimeChoice>("static");
  const [phpVersion, setPhpVersion] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.getRuntime(domainId);
      setRuntime(result.runtime);
      setInstalledPhpVersions(result.installedPhpVersions);
      setChoice(result.runtime.runtime_type);
      setPhpVersion(result.runtime.php_version ?? result.installedPhpVersions[0] ?? "");
      setProxyPort(result.runtime.proxy_port ? String(result.runtime.proxy_port) : "");
    } catch (err) {
      toast.error("Runtime bilgisi alınamadı", err instanceof ApiError ? err.message : "Sunucuya ulaşılamadı.");
    }
  }, [domainId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const input: DomainRuntime =
        choice === "php"
          ? { runtime_type: "php", php_version: phpVersion.trim(), proxy_port: null }
          : choice === "proxy"
            ? { runtime_type: "proxy", php_version: null, proxy_port: Number(proxyPort) }
            : { runtime_type: "static", php_version: null, proxy_port: null };
      const result = await api.setRuntime(domainId, input);
      setRuntime(result.runtime);
      onChange?.();
      toast.ok(
        "Runtime kaydedildi",
        "Değişikliğin geçerli olması için Nginx sekmesinden config'i yeniden üretip uygulayın.",
      );
    } catch (err) {
      toast.error("Kaydedilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  if (!runtime) {
    return (
      <Panel>
        <PanelBody>
          <LoadingRow label="Runtime bilgisi okunuyor" />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead
        title={
          <>
            <CommandLineIcon aria-hidden="true" />
            Runtime
          </>
        }
      />
      <PanelBody>
        <div className="sp-stack">
          <p className="sp-hint">
            Domain&apos;in nasıl sunulacağını seçin: düz statik dosyalar, PHP-FPM (PHP uygulamaları) veya
            kendi sunucusunu ayağa kaldıran bir uygulamaya (ASP.NET/Node/vb.) reverse-proxy.
          </p>

          <Field label="Çalışma zamanı">
            <select
              className="sp-input"
              value={choice}
              onChange={(event) => setChoice(event.target.value as RuntimeChoice)}
            >
              <option value="static">Statik dosyalar</option>
              <option value="php">PHP (PHP-FPM)</option>
              <option value="proxy">Reverse proxy (ASP.NET / Node / özel uygulama)</option>
            </select>
          </Field>

          {choice === "php" && (
            <Field
              label="PHP sürümü"
              hint={
                installedPhpVersions.length > 0
                  ? "Sunucuda tespit edilen PHP-FPM sürümleri listelendi."
                  : "Sunucuda PHP-FPM tespit edilemedi — yine de elle bir sürüm numarası girip kaydedebilirsiniz, ancak soket gerçekten yoksa istekler 502 alır."
              }
            >
              {installedPhpVersions.length > 0 ? (
                <select className="sp-input" value={phpVersion} onChange={(event) => setPhpVersion(event.target.value)}>
                  {installedPhpVersions.map((v) => (
                    <option key={v} value={v}>
                      PHP {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="sp-input sp-mono"
                  value={phpVersion}
                  onChange={(event) => setPhpVersion(event.target.value)}
                  placeholder="8.2"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
          )}

          {choice === "proxy" && (
            <Field label="Uygulama portu" hint="Uygulamanız 127.0.0.1 üzerinde bu portu dinlemeli.">
              <input
                className="sp-input sp-mono"
                type="number"
                min={1}
                max={65535}
                value={proxyPort}
                onChange={(event) => setProxyPort(event.target.value)}
                placeholder="5000"
              />
            </Field>
          )}

          <Note tone="info">
            Kaydetmek yalnızca ayarı günceller. Canlı Nginx yapılandırmasına yansıması için
            <strong> Nginx</strong> sekmesinden config&apos;i yeniden üretip uygulamanız gerekir.
          </Note>

          <div>
            <Button variant="primary" onClick={save} loading={busy}>
              Kaydet
            </Button>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}
