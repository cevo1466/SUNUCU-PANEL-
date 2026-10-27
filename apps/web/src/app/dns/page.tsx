"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { DomainGate, DomainPicker } from "@/components/domain/DomainPicker";
import { DnsManager } from "@/components/features/DnsManager";

function DnsView() {
  const { domains } = useShell();
  const searchParams = useSearchParams();
  const requested = Number(searchParams.get("domain"));
  const [selectedId, setSelectedId] = useState<number | null>(
    Number.isFinite(requested) && requested > 0 ? requested : null,
  );

  useEffect(() => {
    if (domains && domains.length > 0 && selectedId === null) setSelectedId(domains[0].id);
  }, [domains, selectedId]);

  return (
    <>
      <PageHeader title="DNS kayıtları" breadcrumb="Hosting servisleri" />
      <DomainGate domains={domains}>
        {(list) => {
          const current = list.find((domain) => domain.id === selectedId) ?? list[0];
          return (
            <div className="sp-stack">
              <DomainPicker
                domains={list}
                selectedId={current.id}
                onSelect={setSelectedId}
                label="DNS bölgesi"
              />
              <DnsManager key={current.id} domainId={current.id} />
            </div>
          );
        }}
      </DomainGate>
    </>
  );
}

export default function DnsPage() {
  return (
    <AppShell>
      {/* useSearchParams bir Suspense sınırı ister; ?domain= parametresi
          okunana kadar sayfa başlığı görünür kalsın. */}
      <Suspense fallback={<PageHeader title="DNS kayıtları" breadcrumb="Hosting servisleri" />}>
        <DnsView />
      </Suspense>
    </AppShell>
  );
}
