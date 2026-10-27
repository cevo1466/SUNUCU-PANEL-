"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatClock } from "@/lib/format";

export interface ChartPoint {
  t: number;
  /** Ölçüm alınamadıysa null — çizgide boşluk bırakılır, sıfır çizilmez. */
  value: number | null;
}

const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

/**
 * Zaman serisi alan grafiği. Elle yazılmış SVG — grafik kütüphanesi yok:
 * tek serilik bir alan için <path> üretmek yeterli ve hazır kütüphanelerin
 * varsayılan görünümü panelin kendi diline uymuyor.
 *
 * Tek seri olduğu için efsane (legend) yok; başlık seriyi zaten adlandırıyor.
 * Anlık değer çağıran tarafta metin olarak da yazılır, böylece bilgi yalnızca
 * renkle taşınmaz.
 */
export function AreaChart({
  points,
  height = 120,
  yMax = 100,
  formatValue,
  ariaLabel,
  emptyText = "Veri toplanıyor…",
}: {
  points: ChartPoint[];
  height?: number;
  yMax?: number;
  formatValue: (value: number) => string;
  ariaLabel: string;
  emptyText?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Kabın gerçek genişliğini ölçüyoruz. viewBox'ı esnetmek yerine gerçek
  // piksele çizmek çizgi kalınlığının ve yazı boyutunun sabit kalmasını sağlar.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const plotWidth = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const plotHeight = Math.max(0, height - PAD_TOP - PAD_BOTTOM);

  const geometry = useMemo(() => {
    if (plotWidth <= 0 || points.length < 2) return null;

    const first = points[0].t;
    const last = points[points.length - 1].t;
    const span = Math.max(1, last - first);

    const x = (t: number) => PAD_LEFT + ((t - first) / span) * plotWidth;
    const y = (v: number) => PAD_TOP + plotHeight - (Math.min(yMax, Math.max(0, v)) / yMax) * plotHeight;

    // Ölçüm alınamayan aralıklar çizgiyi böler: null'ı sıfır gibi çizmek
    // "yük düştü" yanılsaması yaratırdı.
    const segments: Array<Array<{ x: number; y: number }>> = [];
    let current: Array<{ x: number; y: number }> = [];
    for (const point of points) {
      if (point.value === null) {
        if (current.length) segments.push(current);
        current = [];
        continue;
      }
      current.push({ x: x(point.t), y: y(point.value) });
    }
    if (current.length) segments.push(current);

    const toLine = (segment: Array<{ x: number; y: number }>) =>
      segment.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

    const baseline = PAD_TOP + plotHeight;
    const linePath = segments.map(toLine).join(" ");
    const areaPath = segments
      .filter((segment) => segment.length > 1)
      .map(
        (segment) =>
          `${toLine(segment)} L${segment[segment.length - 1].x.toFixed(1)} ${baseline} L${segment[0].x.toFixed(1)} ${baseline} Z`,
      )
      .join(" ");

    return { x, y, linePath, areaPath, baseline, first, last };
  }, [points, plotWidth, plotHeight, yMax]);

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!geometry || points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const ratio = (localX - PAD_LEFT) / Math.max(1, plotWidth);
    const target = geometry.first + ratio * (geometry.last - geometry.first);

    // En yakın örneği bul — imleç iki nokta arasındayken hangisine yakınsa o.
    let nearest = 0;
    let bestDistance = Infinity;
    points.forEach((point, index) => {
      const distance = Math.abs(point.t - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = index;
      }
    });
    setHoverIndex(nearest);
  }

  if (points.length < 2 || !geometry) {
    return (
      <div className="sp-chart" ref={wrapRef}>
        <div className="sp-chart-empty" style={{ height }}>
          {emptyText}
        </div>
      </div>
    );
  }

  const gridValues = [0, yMax / 2, yMax];

  return (
    <div className="sp-chart" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIndex(null)}
        style={{ touchAction: "pan-y" }}
      >
        {gridValues.map((value) => {
          const gy = geometry.y(value);
          return (
            <g key={value}>
              <line className="sp-chart-grid" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={gy} y2={gy} />
              <text className="sp-chart-axis" x={PAD_LEFT - 6} y={gy + 3} textAnchor="end">
                {formatValue(value)}
              </text>
            </g>
          );
        })}

        {geometry.areaPath && <path className="sp-chart-area" d={geometry.areaPath} />}
        <path className="sp-chart-line" d={geometry.linePath} />

        {hovered && hovered.value !== null && (
          <g>
            <line
              className="sp-chart-crosshair"
              x1={geometry.x(hovered.t)}
              x2={geometry.x(hovered.t)}
              y1={PAD_TOP}
              y2={geometry.baseline}
            />
            <circle
              className="sp-chart-marker"
              cx={geometry.x(hovered.t)}
              cy={geometry.y(hovered.value)}
              r={4}
            />
          </g>
        )}

        <text className="sp-chart-axis" x={PAD_LEFT} y={height - 5}>
          {formatClock(geometry.first)}
        </text>
        <text className="sp-chart-axis" x={width - PAD_RIGHT} y={height - 5} textAnchor="end">
          {formatClock(geometry.last)}
        </text>
      </svg>

      {hovered && hovered.value !== null && (
        <div
          className="sp-chart-tooltip"
          style={{
            left: Math.min(width - 8, Math.max(8, geometry.x(hovered.t))),
            top: geometry.y(hovered.value) - 8,
          }}
        >
          {formatValue(hovered.value)} · {formatClock(hovered.t)}
        </div>
      )}
    </div>
  );
}
