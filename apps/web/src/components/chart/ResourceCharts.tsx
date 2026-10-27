"use client";

import { useState } from "react";
import { CpuChipIcon, CircleStackIcon, ServerStackIcon } from "@heroicons/react/24/outline";
import type { MetricsHistory, MetricsRange, ResourceMetrics } from "@/lib/api";
import {
  formatBytes,
  formatClock,
  percentOf,
  THRESHOLD_LABEL,
  thresholdOf,
  type Threshold,
} from "@/lib/format";
import { Panel, PanelBody, PanelHead } from "@/components/ui/Panel";
import { Meter } from "@/components/ui/Bits";
import { AreaChart, type ChartPoint } from "./AreaChart";

const RANGES: Array<{ id: MetricsRange; label: string }> = [
  { id: "5m", label: "5 dk" },
  { id: "30m", label: "30 dk" },
  { id: "1h", label: "1 saat" },
];

const percentText = (value: number) => `%${value.toFixed(0)}`;

const RANGE_TEXT: Record<MetricsRange, string> = {
  "5m": "son 5 dakikada",
  "30m": "son 30 dakikada",
  "1h": "son 1 saatte",
};

/**
 * CPU kota beklemesi özeti — YALNIZCA seçili aralık için.
 *
 * Örnekler kümülatif sayaç değil, kendi 5 saniyelik pencerelerinin farkını
 * taşır (bkz. apps/api/src/lib/metrics-history.ts). Burada o farklar
 * toplanıyor. Aralıkta hiç throttle yoksa metin YAZILMAZ: "0 kez takıldı"
 * demek gereksiz gürültü, eski davranış ise günler öncesinin toplamını
 * gösterip yanıltıyordu.
 *
 * @returns Gösterilecek metin, ya da gösterilecek bir şey yoksa null.
 */
function throttleSummary(
  samples: Array<{ throttledPeriods: number | null; periods: number | null }>,
  range: MetricsRange,
): string | null {
  let throttled = 0;
  let periods = 0;
  for (const sample of samples) {
    if (sample.throttledPeriods !== null) throttled += sample.throttledPeriods;
    if (sample.periods !== null) periods += sample.periods;
  }

  if (throttled <= 0) return null;

  const when = RANGE_TEXT[range];
  // Oran, sayının kendisinden daha anlamlı: 6 periyot 100 periyotta bir şey,
  // 6000 periyotta başka bir şeydir.
  if (periods > 0) {
    const ratio = (throttled / periods) * 100;
    const shown = ratio < 0.1 ? "%0,1'in altında" : `%${ratio.toFixed(1).replace(".", ",")}`;
    return `${when} ${shown} kota beklemesi`;
  }
  return `${when} ${throttled} periyot kotaya takıldı`;
}

/** Anlık değer + eşik durumu. Renk asla tek kanal değil — etiket hep yanında. */
function MetricValue({
  value,
  unit,
  threshold,
  sub,
}: {
  value: string;
  unit?: string;
  threshold?: Threshold;
  sub?: string;
}) {
  return (
    <>
      <div className="sp-metric-value">
        {value}
        {unit && <span className="sp-metric-unit">{unit}</span>}
        {threshold && threshold !== "ok" && (
          <span
            className="sp-metric-unit"
            style={{ color: threshold === "err" ? "var(--sp-err)" : "var(--sp-warn-ink)" }}
          >
            · {THRESHOLD_LABEL[threshold]}
          </span>
        )}
      </div>
      {sub && <p className="sp-metric-sub">{sub}</p>}
    </>
  );
}

export function RangePicker({
  range,
  onChange,
}: {
  range: MetricsRange;
  onChange: (range: MetricsRange) => void;
}) {
  return (
    <div className="sp-range" role="group" aria-label="Zaman aralığı">
      {RANGES.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={range === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Grafiğin verisini tablo olarak da sunar: ekran okuyucu ve yazdırma için. */
function SampleTable({
  points,
  unitLabel,
  format,
}: {
  points: ChartPoint[];
  unitLabel: string;
  format: (value: number) => string;
}) {
  const rows = points.filter((p) => p.value !== null).slice(-30).reverse();
  return (
    <div className="sp-table-wrap" style={{ maxHeight: 260, overflowY: "auto" }}>
      <table className="sp-table">
        <thead>
          <tr>
            <th>Saat</th>
            <th className="sp-num">{unitLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((point) => (
            <tr key={point.t}>
              <td className="sp-mono">{formatClock(point.t)}</td>
              <td className="sp-num sp-mono">{format(point.value as number)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartPanel({
  title,
  icon: Icon,
  points,
  head,
  unitLabel,
  format,
  height,
}: {
  title: string;
  icon: typeof CpuChipIcon;
  points: ChartPoint[];
  head: React.ReactNode;
  unitLabel: string;
  format: (value: number) => string;
  height: number;
}) {
  const [showTable, setShowTable] = useState(false);
  const hasData = points.filter((p) => p.value !== null).length >= 2;

  return (
    <Panel>
      <PanelHead
        title={
          <>
            <Icon aria-hidden="true" />
            {title}
          </>
        }
        actions={
          hasData ? (
            <button
              type="button"
              className="sp-btn sp-btn--ghost sp-btn--sm"
              onClick={() => setShowTable((current) => !current)}
              aria-pressed={showTable}
            >
              {showTable ? "Grafiği göster" : "Tabloyu göster"}
            </button>
          ) : undefined
        }
      />
      <PanelBody className="sp-metric">
        {head}
        {showTable ? (
          <SampleTable points={points} unitLabel={unitLabel} format={format} />
        ) : (
          <AreaChart
            points={points}
            height={height}
            formatValue={format}
            ariaLabel={`${title} zaman serisi`}
            emptyText="Veri toplanıyor — ilk noktalar birkaç saniye içinde görünecek."
          />
        )}
      </PanelBody>
    </Panel>
  );
}

export function ResourceCharts({
  history,
  latest,
  range,
  onRangeChange,
  compact = false,
}: {
  history: MetricsHistory | null;
  latest: ResourceMetrics | null;
  range: MetricsRange;
  onRangeChange: (range: MetricsRange) => void;
  /** Panel özetinde daha kısa grafikler ve aralık seçici olmadan. */
  compact?: boolean;
}) {
  const samples = history?.samples ?? [];
  const cpuPoints: ChartPoint[] = samples.map((s) => ({ t: s.t, value: s.cpuPercent }));
  const memPoints: ChartPoint[] = samples.map((s) => ({ t: s.t, value: s.memPercent }));

  const cpuNow = latest?.cpu.usagePercent ?? null;
  const memUsed = latest?.memory.usedBytes ?? 0;
  const memLimit = latest?.memory.limitBytes ?? null;
  const memPercentNow = percentOf(memUsed, memLimit);

  // Kota beklemesi, SEÇİLİ ARALIĞA ait. Daha önce cgroup'un kümülatif
  // nr_throttled sayacı ham gösteriliyordu ("338 kez kotaya takıldı"); o sayı
  // konteyner açılışından beri toplamdı, hiç sıfırlanmıyordu ve şu an sorun
  // varmış gibi okunuyordu. Artık pencere farklarının toplamı kullanılıyor.
  const throttleText = throttleSummary(samples, range);

  const diskTotal = latest?.disk.totalBytes ?? 0;
  const diskUsed = latest?.disk.usedBytes ?? 0;
  const diskPercent = percentOf(diskUsed, diskTotal);

  const height = compact ? 78 : 150;

  return (
    <div className="sp-stack">
      {!compact && (
        <div className="sp-row">
          <span className="sp-hint">
            {history
              ? `${samples.length} ölçüm · ${(history.intervalMs / 1000).toFixed(0)} saniyede bir`
              : "Ölçümler yükleniyor"}
          </span>
          <div style={{ marginLeft: "auto" }}>
            <RangePicker range={range} onChange={onRangeChange} />
          </div>
        </div>
      )}

      <div className="sp-metric-grid">
        <ChartPanel
          title="İşlemci"
          icon={CpuChipIcon}
          points={cpuPoints}
          unitLabel="Kullanım"
          format={percentText}
          height={height}
          head={
            <MetricValue
              value={cpuNow === null ? "—" : `%${cpuNow.toFixed(1).replace(".", ",")}`}
              threshold={thresholdOf(cpuNow)}
              sub={
                latest?.cpu.vcpus
                  ? `${latest.cpu.vcpus} vCPU üzerinden${throttleText ? ` · ${throttleText}` : ""}`
                  : undefined
              }
            />
          }
        />

        <ChartPanel
          title="Bellek"
          icon={CircleStackIcon}
          points={memPoints}
          unitLabel="Kullanım"
          format={percentText}
          height={height}
          head={
            <MetricValue
              value={formatBytes(memUsed)}
              threshold={thresholdOf(memPercentNow)}
              sub={
                memLimit
                  ? `${formatBytes(memLimit)} sınırının %${(memPercentNow ?? 0).toFixed(0)} kadarı`
                  : "cgroup bellek sınırı tanımlı değil"
              }
            />
          }
        />

        {/* Disk çok yavaş değişir; düz bir zaman serisi çizmek sahte grafik
            olurdu. Bütünün parçası olarak ölçü çubuğu doğru form. */}
        <Panel>
          <PanelHead
            title={
              <>
                <ServerStackIcon aria-hidden="true" />
                Disk
              </>
            }
          />
          <PanelBody className="sp-metric">
            <MetricValue
              value={formatBytes(diskUsed)}
              threshold={thresholdOf(diskPercent)}
              sub={
                diskTotal
                  ? `${formatBytes(diskTotal)} toplam · ${formatBytes(latest?.disk.availableBytes ?? 0)} boş`
                  : undefined
              }
            />
            <Meter
              label={latest?.disk.path ?? "Disk"}
              percent={diskPercent}
              valueText={diskPercent === null ? "—" : `%${diskPercent.toFixed(1).replace(".", ",")}`}
              threshold={thresholdOf(diskPercent)}
            />
            {!compact && (
              <p className="sp-metric-sub">
                Ölçüm noktası <span className="sp-mono">{latest?.disk.path ?? "—"}</span>
              </p>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
