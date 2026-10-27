"use client";

import { useEffect, useState } from "react";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { DomainGate, DomainPicker } from "@/components/domain/DomainPicker";
import { DatabaseManager } from "@/components/features/DatabaseManager";
import { AdminerSettings } from "@/components/features/AdminerSettings";

function DatabasesView() {
  const { domains } = useShell();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    if (domains && domains.length > 0 && selectedId === null) setSelectedId(domains[0].id);
  }, [domains, selectedId]);

  return (
    <>
      <PageHeader title="Veritabanları" breadcrumb="Hosting servisleri" />
      <AdminerSettings />
      <DomainGate domains={domains}>
        {(list) => {
          const current = list.find((domain) => domain.id === selectedId) ?? list[0];
          return (
            <div className="sp-stack">
              <DomainPicker
                domains={list}
                selectedId={current.id}
                onSelect={setSelectedId}
                label="Domain"
              />
              {/* key: domain değişince bileşen sıfırdan kurulsun, önceki
                  domainin listesi bir an görünmesin. */}
              <DatabaseManager key={current.id} domainId={current.id} />
            </div>
          );
        }}
      </DomainGate>
    </>
  );
}

export default function DatabasesPage() {
  return (
    <AppShell>
      <DatabasesView />
    </AppShell>
  );
}
