"use client";

import { useEffect, useState } from "react";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { DomainGate, DomainPicker } from "@/components/domain/DomainPicker";
import { FileManager } from "@/components/features/FileManager";

function FilesView() {
  const { domains } = useShell();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    if (domains && domains.length > 0 && selectedId === null) setSelectedId(domains[0].id);
  }, [domains, selectedId]);

  return (
    <>
      <PageHeader title="Dosya yöneticisi" breadcrumb="Hosting servisleri" />
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
              <FileManager
                key={current.id}
                domainId={current.id}
                rootLabel={current.domain_name}
              />
            </div>
          );
        }}
      </DomainGate>
    </>
  );
}

export default function FilesPage() {
  return (
    <AppShell>
      <FilesView />
    </AppShell>
  );
}
