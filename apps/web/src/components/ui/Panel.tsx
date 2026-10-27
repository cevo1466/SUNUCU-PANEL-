import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("sp-panel", className)} {...rest}>
      {children}
    </section>
  );
}

export function PanelHead({
  title,
  note,
  actions,
}: {
  title: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="sp-panel-head">
      <h2 className="sp-panel-title">{title}</h2>
      {note && <span className="sp-panel-note">{note}</span>}
      {actions && <div className="sp-panel-head-actions">{actions}</div>}
    </header>
  );
}

export function PanelBody({
  children,
  flush = false,
  className,
}: {
  children: ReactNode;
  /** Tablo ve liste gibi kenara dayanması gereken içerikler için. */
  flush?: boolean;
  className?: string;
}) {
  return <div className={cn("sp-panel-body", flush && "sp-panel-body--flush", className)}>{children}</div>;
}

export function PanelFoot({ children }: { children: ReactNode }) {
  return <footer className="sp-panel-foot">{children}</footer>;
}
