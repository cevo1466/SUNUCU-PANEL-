import type { ComponentType, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";
import { THRESHOLD_LABEL, type Threshold } from "@/lib/format";

/* ---------- rozet ---------- */

export type BadgeTone = "neutral" | "ok" | "warn" | "err" | "info";

export function Badge({
  tone = "neutral",
  icon: Icon,
  children,
}: {
  tone?: BadgeTone;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  children: ReactNode;
}) {
  return (
    <span className={`sp-badge sp-badge--${tone}`}>
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

/* ---------- durum noktası ---------- */

export function StatusDot({ state }: { state: "ok" | "warn" | "err" | "idle" }) {
  return <span className="sp-dot" data-state={state === "idle" ? undefined : state} aria-hidden="true" />;
}

/* ---------- ölçü çubuğu ---------- */

/**
 * Bütünün parçası ölçüsü (disk, bellek). Zaman serisi değil, oran gösterir.
 * Yüzde her zaman metin olarak da yazılır: renk tek kanal değildir.
 */
export function Meter({
  label,
  percent,
  valueText,
  threshold,
}: {
  label: string;
  percent: number | null;
  valueText: string;
  threshold: Threshold;
}) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div>
      <div className="sp-meter-head">
        <span className="sp-meter-label">{label}</span>
        <span className="sp-meter-value">
          {valueText}
          {threshold !== "ok" && ` · ${THRESHOLD_LABEL[threshold]}`}
        </span>
      </div>
      <div
        className="sp-meter-track"
        role="meter"
        aria-label={label}
        aria-valuenow={percent === null ? undefined : Math.round(width)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText}
      >
        <div
          className="sp-meter-fill"
          data-state={threshold === "ok" ? undefined : threshold}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

/* ---------- boş durum ---------- */

export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="sp-empty">
      {Icon && <Icon aria-hidden="true" />}
      <p className="sp-empty-title">{title}</p>
      {text && <p className="sp-empty-text">{text}</p>}
      {action}
    </div>
  );
}

/* ---------- yükleniyor ---------- */

export function LoadingRow({ label = "Yükleniyor" }: { label?: string }) {
  return (
    <div className="sp-empty" style={{ padding: "26px 20px" }}>
      <span className="sp-spinner" style={{ color: "var(--sp-ink-faint)" }} aria-hidden="true" />
      <p className="sp-empty-text">{label}</p>
    </div>
  );
}

/* ---------- form alanı ---------- */

export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("sp-field", className)}>
      <span className="sp-label">{label}</span>
      {children}
      {hint && !error && <span className="sp-hint">{hint}</span>}
      {error && <span className="sp-field-error">{error}</span>}
    </label>
  );
}

/* ---------- açıklama kutusu ---------- */

export function Note({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warn" | "ok" | "err";
}) {
  return (
    <div
      className={cn(
        "sp-note",
        tone === "warn" && "sp-note--warn",
        tone === "ok" && "sp-note--ok",
        tone === "err" && "sp-note--err",
      )}
    >
      {children}
    </div>
  );
}
