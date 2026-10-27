"use client";

import { useState } from "react";
import { CheckIcon, ClipboardDocumentIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type Domain } from "@/lib/api";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Button } from "@/components/ui/button";
import { Badge, Note } from "@/components/ui/Bits";
import { useToast } from "@/components/ui/Toast";

export function NginxConfigView({
  domainName,
  content,
  applied,
  applyError,
}: {
  domainName: string;
  content: string;
  applied?: boolean;
  applyError?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Kopyalanamadı", "Tarayıcı panoya yazma izni vermedi. Metni seçip elle kopyalayın.");
    }
  }

  return (
    <div className="sp-stack">
      <div className="sp-row">
        <span className="sp-hint sp-mono">ops/generated/{domainName}.conf</span>
        <div style={{ marginLeft: "auto" }}>
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? <CheckIcon aria-hidden="true" /> : <ClipboardDocumentIcon aria-hidden="true" />}
            {copied ? "Kopyalandı" : "Kopyala"}
          </Button>
        </div>
      </div>
      <pre className="sp-code">{content}</pre>
      {applied ? (
        <Note tone="ok">
          Config <span className="sp-mono">/etc/nginx/conf.d/{domainName}.conf</span> dosyasına
          uygulandı ve <span className="sp-mono">proxy-server</span> container&apos;ında Nginx yeniden
          yüklendi.
        </Note>
      ) : (
        <Note tone="warn">
          Config yalnızca <span className="sp-mono">ops/generated/</span> altına yazıldı; canlı Nginx
          yapılandırması DEĞİŞMEDİ.
          {applyError && (
            <>
              {" "}
              Otomatik uygulama başarısız oldu: <span className="sp-mono">{applyError}</span>.
            </>
          )}{" "}
          Yayına almak için sunucuda{" "}
          <span className="sp-mono">sudo ops/scripts/deploy-vhost.sh {domainName}</span> çalıştırın —
          script <span className="sp-mono">nginx -t</span> başarısız olursa eski config&apos;i geri
          yükler.
        </Note>
      )}
    </div>
  );
}

export function NginxPanel({ domain, onGenerated }: { domain: Domain; onGenerated?: () => void }) {
  const toast = useToast();
  const [content, setContent] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [applyError, setApplyError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const result = await api.generateNginxConfig(domain.id);
      setContent(result.content);
      setApplied(result.applied);
      setApplyError(result.apply_error);
      onGenerated?.();
      if (result.applied) {
        // HTTPS'in korunduğunu SÖYLEMEK önemli: sertifikası olan bir domainde
        // config yenilemek eskiden siteyi sessizce düz HTTP'ye düşürüyordu.
        toast.ok(
          "Nginx'e uygulandı",
          result.https
            ? `${domain.domain_name} canlı yapılandırmada; HTTPS bloğu korundu.`
            : `${domain.domain_name} artık canlı Nginx yapılandırmasında.`,
        );
      } else {
        toast.error(
          "Config üretildi, Nginx'e uygulanamadı",
          result.apply_error ?? "Sunucuda manuel deploy-vhost.sh çalıştırılmalı.",
        );
      }
    } catch (err) {
      toast.error("Config üretilemedi", err instanceof ApiError ? err.message : "İşlem tamamlanmadı.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <PanelHead
        title={
          <>
            <Cog6ToothIcon aria-hidden="true" />
            Nginx yapılandırması
          </>
        }
        actions={
          <>
            <Badge tone={domain.nginx_deployed ? "ok" : domain.config_generated ? "info" : "neutral"}>
              {domain.nginx_deployed
                ? "Nginx'te yayında"
                : domain.config_generated
                  ? "Config üretildi"
                  : "Config üretilmedi"}
            </Badge>
            <Button variant="primary" size="sm" onClick={generate} loading={busy}>
              {domain.config_generated ? "Yeniden üret" : "Config üret"}
            </Button>
          </>
        }
      />
      <PanelBody>
        {content ? (
          <NginxConfigView
            domainName={domain.domain_name}
            content={content}
            applied={applied}
            applyError={applyError}
          />
        ) : (
          <div className="sp-stack">
            <p className="sp-hint">
              Domain için HTTP/2 hazır bir Nginx sunucu bloğu üretilir. Dosya{" "}
              <span className="sp-mono">ops/generated/{domain.domain_name}.conf</span> altına yazılır;
              canlı yapılandırmaya operatör onayıyla alınır.
            </p>
            <table className="sp-table" style={{ border: "1px solid var(--sp-line)" }}>
              <tbody>
                <tr>
                  <th style={{ width: 160 }}>Belge kökü</th>
                  {/* directory_path zaten domainin belge kökünü (`.../public`) taşır. */}
                  <td className="sp-mono">{domain.directory_path}</td>
                </tr>
                <tr>
                  <th>Dizin durumu</th>
                  <td>{domain.directory_exists ? "Sunucuda mevcut" : "Dizin bulunamadı"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
