"use client";

import { GlobeAltIcon } from "@heroicons/react/24/outline";
import type { Domain } from "@/lib/api";
import { Panel, PanelBody } from "@/components/ui/Panel";
import { EmptyState, LoadingRow } from "@/components/ui/Bits";
import Link from "next/link";

/**
 * Servis sayfalarında (dosya, yedek) hangi domain üzerinde çalışılacağını
 * seçtirir. Tek domain varsa seçici yerine doğrudan o domain kullanılır.
 */
export function DomainPicker({
  domains,
  selectedId,
  onSelect,
  label,
}: {
  domains: Domain[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  label: string;
}) {
  if (domains.length <= 1) return null;

  return (
    <div className="sp-row">
      <label className="sp-row" style={{ gap: 8 }}>
        <span className="sp-label">{label}</span>
        <select
          className="sp-select"
          style={{ width: "auto", minWidth: 220 }}
          value={selectedId ?? ""}
          onChange={(event) => onSelect(Number(event.target.value))}
        >
          {domains.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {domain.domain_name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Domain listesi boş/yükleniyorken servis sayfalarının ortak durumu. */
export function DomainGate({
  domains,
  children,
}: {
  domains: Domain[] | null;
  children: (domains: Domain[]) => React.ReactNode;
}) {
  if (domains === null) {
    return (
      <Panel>
        <PanelBody flush>
          <LoadingRow label="Domainler yükleniyor" />
        </PanelBody>
      </Panel>
    );
  }

  if (domains.length === 0) {
    return (
      <Panel>
        <PanelBody flush>
          <EmptyState
            icon={GlobeAltIcon}
            title="Önce bir domain ekleyin"
            text="Bu sayfa domain başına çalışır. Domain eklendiğinde burada görünür."
            action={
              <Link className="sp-btn sp-btn--primary" href="/domains">
                Domainlere git
              </Link>
            }
          />
        </PanelBody>
      </Panel>
    );
  }

  return <>{children(domains)}</>;
}
