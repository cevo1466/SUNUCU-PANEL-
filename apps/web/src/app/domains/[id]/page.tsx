"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArchiveBoxIcon,
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  CircleStackIcon,
  CloudIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  EnvelopeIcon,
  FolderIcon,
  LockClosedIcon,
  ServerStackIcon,
  Squares2X2Icon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { api, type BackupVersion, type Domain } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { AppShell, PageHeader, useShell } from "@/components/layout/AppShell";
import { Panel, PanelBody } from "@/components/ui/Panel";
import { Tabs, TabPanel, type TabDef } from "@/components/ui/Tabs";
import { EmptyState, LoadingRow, Note } from "@/components/ui/Bits";
import { DomainStatusBadges } from "@/components/domain/DomainCard";
import { ToolGrid } from "@/components/domain/ToolGrid";
import { buildDomainTools } from "@/components/domain/domainTools";
import { FileManager } from "@/components/features/FileManager";
import { DnsManager } from "@/components/features/DnsManager";
import { SslManager } from "@/components/features/SslManager";
import { BackupManager } from "@/components/features/BackupManager";
import { NginxPanel } from "@/components/features/NginxPanel";
import { FtpManager } from "@/components/features/FtpManager";
import { DatabaseManager } from "@/components/features/DatabaseManager";
import { CustomerAccessManager } from "@/components/features/CustomerAccessManager";
import { RuntimeManager } from "@/components/features/RuntimeManager";
import { MailManager } from "@/components/features/MailManager";

const TAB_IDS = ["panel", "files", "ftp", "mail", "databases", "dns", "ssl", "backups", "nginx", "runtime", "access"] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

function DomainWorkspace({ domainId }: { domainId: number }) {
  const { domains, reloadDomains, user } = useShell();
  const isAdmin = user?.role === "admin";
  const router = useRouter();
  const searchParams = useSearchParams();

  const [dnsCount, setDnsCount] = useState<number | undefined>();
  const [databaseCount, setDatabaseCount] = useState<number | undefined>();
  const [mailCount, setMailCount] = useState<number | undefined>();
  const [backup, setBackup] = useState<BackupVersion | null>(null);

  const domain: Domain | undefined = domains?.find((item) => item.id === domainId);

  // Seçili sekme URL'de tutulur: sayfa yenilendiğinde veya bağlantı
  // paylaşıldığında aynı sekme açılır.
  const rawTab = searchParams.get("tab");
  const activeTab: TabId = isTabId(rawTab) ? rawTab : "panel";

  const setTab = useCallback(
    (tab: TabId) => {
      const params = new URLSearchParams(searchParams.toString());
      if (tab === "panel") params.delete("tab");
      else params.set("tab", tab);
      const query = params.toString();
      router.replace(`/domains/${domainId}${query ? `?${query}` : ""}`, { scroll: false });
    },
    [domainId, router, searchParams],
  );

  // Kutucuklardaki sayılar için: DNS kayıt adedi, veritabanı adedi ve yedek
  // bilgisi. allSettled: biri başarısız olursa diğerlerinin notu yine yazılır;
  // alınamayan sayı için not HİÇ yazılmaz (uydurma sıfır gösterilmez).
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.listDnsRecords(domainId),
      api.listBackups(domainId),
      api.listDatabases(domainId),
      api.listMailAccounts(domainId),
    ]).then(([dnsResult, backupResult, dbResult, mailResult]) => {
      if (cancelled) return;
      if (dnsResult.status === "fulfilled") setDnsCount(dnsResult.value.records.length);
      // Kart yalnizca EN SON yedegi gosteriyor; liste zaten Yedekler sekmesinde.
      if (backupResult.status === "fulfilled") setBackup(backupResult.value.backups[0] ?? null);
      if (dbResult.status === "fulfilled") setDatabaseCount(dbResult.value.databases.length);
      if (mailResult.status === "fulfilled") setMailCount(mailResult.value.accounts.length);
    });
    return () => {
      cancelled = true;
    };
  }, [domainId]);

  const tabs = useMemo<TabDef<TabId>[]>(
    () => [
      { id: "panel", label: "Panel", icon: Squares2X2Icon },
      { id: "files", label: "Dosyalar", icon: FolderIcon },
      { id: "ftp", label: "FTP", icon: ServerStackIcon },
      { id: "mail", label: "E-posta", icon: EnvelopeIcon, count: mailCount },
      { id: "databases", label: "Veritabanları", icon: CircleStackIcon, count: databaseCount },
      { id: "dns", label: "DNS", icon: CloudIcon, count: dnsCount },
      { id: "ssl", label: "SSL", icon: LockClosedIcon },
      { id: "backups", label: "Yedekler", icon: ArchiveBoxIcon },
      { id: "nginx", label: "Nginx", icon: Cog6ToothIcon },
      { id: "runtime", label: "Runtime", icon: CommandLineIcon },
      ...(isAdmin ? [{ id: "access" as const, label: "Erişim", icon: UserIcon }] : []),
    ],
    [dnsCount, databaseCount, mailCount, isAdmin],
  );

  if (domains === null) {
    return (
      <>
        <PageHeader title="Domain yükleniyor" />
        <Panel>
          <PanelBody flush>
            <LoadingRow />
          </PanelBody>
        </Panel>
      </>
    );
  }

  if (!domain) {
    return (
      <>
        <PageHeader title="Domain bulunamadı" breadcrumb={<Link href="/domains">Domainler</Link>} />
        <Panel>
          <PanelBody flush>
            <EmptyState
              title="Bu domain listenizde yok"
              text="Silinmiş olabilir veya bağlantıdaki numara hatalı."
              action={
                <Link className="sp-btn sp-btn--primary" href="/domains">
                  Domain listesine dön
                </Link>
              }
            />
          </PanelBody>
        </Panel>
      </>
    );
  }

  const tools = buildDomainTools({
    domain,
    dnsCount,
    databaseCount,
    mailCount,
    backup,
    onGenerateNginx: () => setTab("nginx"),
    isAdmin,
  });

  return (
    <>
      <PageHeader
        title={domain.domain_name}
        breadcrumb={
          <>
            <Link href="/domains">Domainler</Link>
            <ChevronRightIcon aria-hidden="true" />
            <span>{domain.domain_name}</span>
          </>
        }
        actions={
          <a
            className="sp-btn sp-btn--secondary"
            href={`http://${domain.domain_name}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ArrowTopRightOnSquareIcon aria-hidden="true" />
            Siteyi aç
          </a>
        }
      />

      <div className="sp-stack">
        <Panel>
          <Tabs tabs={tabs} active={activeTab} onChange={setTab} label="Domain yönetimi" />

          <TabPanel id="panel" active={activeTab === "panel"}>
            <div className="sp-tool-section" style={{ borderBottom: "1px solid var(--sp-line)" }}>
              <div className="sp-row" style={{ gap: 6 }}>
                <span className="sp-mono sp-hint">{domain.directory_path}</span>
                <span className="sp-hint">· {formatDate(domain.created_at)} tarihinde eklendi</span>
                <div className="sp-row" style={{ gap: 6, marginLeft: "auto" }}>
                  <DomainStatusBadges domain={domain} />
                </div>
              </div>
            </div>
            <ToolGrid sections={tools} />
          </TabPanel>
        </Panel>

        <TabPanel id="files" active={activeTab === "files"}>
          {domain.directory_exists ? (
            <FileManager domainId={domain.id} rootLabel={domain.domain_name} />
          ) : (
            <Panel>
              <PanelBody>
                <Note tone="warn">
                  <span className="sp-mono">{domain.directory_path}</span> sunucuda bulunamadı. Dizin elle
                  silinmiş olabilir; domaini kaldırıp yeniden ekleyerek yapıyı yeniden oluşturabilirsiniz.
                </Note>
              </PanelBody>
            </Panel>
          )}
        </TabPanel>

        <TabPanel id="dns" active={activeTab === "dns"}>
          <DnsManager domainId={domain.id} onCountChange={setDnsCount} />
        </TabPanel>

        <TabPanel id="ftp" active={activeTab === "ftp"}>
          <FtpManager domainId={domain.id} />
        </TabPanel>

        <TabPanel id="mail" active={activeTab === "mail"}>
          <MailManager domainId={domain.id} domainName={domain.domain_name} onCountChange={setMailCount} />
        </TabPanel>

        <TabPanel id="databases" active={activeTab === "databases"}>
          <DatabaseManager domainId={domain.id} />
        </TabPanel>

        <TabPanel id="ssl" active={activeTab === "ssl"}>
          <SslManager domainId={domain.id} onChange={reloadDomains} />
        </TabPanel>

        <TabPanel id="backups" active={activeTab === "backups"}>
          <BackupManager
            domainId={domain.id}
            domainName={domain.domain_name}
            onChange={setBackup}
          />
        </TabPanel>

        <TabPanel id="nginx" active={activeTab === "nginx"}>
          <NginxPanel domain={domain} onGenerated={reloadDomains} />
        </TabPanel>

        <TabPanel id="runtime" active={activeTab === "runtime"}>
          <RuntimeManager domainId={domain.id} onChange={reloadDomains} />
        </TabPanel>

        {isAdmin && (
          <TabPanel id="access" active={activeTab === "access"}>
            <CustomerAccessManager domain={domain} onChange={reloadDomains} />
          </TabPanel>
        )}
      </div>
    </>
  );
}

export default function DomainDetailPage() {
  const params = useParams<{ id: string }>();
  const domainId = Number(params.id);

  return (
    <AppShell>
      {Number.isFinite(domainId) ? (
        <Suspense fallback={<PageHeader title="Domain yükleniyor" />}>
          <DomainWorkspace domainId={domainId} />
        </Suspense>
      ) : (
        <>
          <PageHeader title="Geçersiz adres" />
          <Panel>
            <PanelBody flush>
              <EmptyState
                title="Bağlantı hatalı"
                text="Domain numarası okunamadı."
                action={
                  <Link className="sp-btn sp-btn--primary" href="/domains">
                    Domain listesine dön
                  </Link>
                }
              />
            </PanelBody>
          </Panel>
        </>
      )}
    </AppShell>
  );
}
