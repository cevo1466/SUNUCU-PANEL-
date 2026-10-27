import Link from "next/link";
import type { ComponentType, ReactNode, SVGProps } from "react";

export interface Tool {
  key: string;
  name: string;
  /** Gerçek veriden gelen alt satır: kayıt adedi, boyut, tarih. Sabit metin değil. */
  note?: ReactNode;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Ya bir sayfaya götürür ya da bir işlem tetikler — ikisi de yoksa kutucuk yazılmaz. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Devre dışıysa nedenini söyler (tooltip). */
  disabledReason?: string;
}

export interface ToolSection {
  title: string;
  tools: Tool[];
}

function ToolTile({ tool }: { tool: Tool }) {
  const inner = (
    <>
      <span className="sp-tile-icon" aria-hidden="true">
        <tool.icon />
      </span>
      <span className="sp-tile-text">
        <span className="sp-tile-name">{tool.name}</span>
        {tool.note && <span className="sp-tile-note">{tool.note}</span>}
      </span>
    </>
  );

  if (tool.href && !tool.disabled) {
    return (
      <Link className="sp-tile" href={tool.href}>
        {inner}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className="sp-tile"
      onClick={tool.onClick}
      disabled={tool.disabled || !tool.onClick}
      title={tool.disabled ? tool.disabledReason : undefined}
    >
      {inner}
    </button>
  );
}

/**
 * Plesk'in domain kartındaki araç ızgarası: bir alan adının bütün yönetim
 * araçları tek ekranda, gruplanmış ve görünür. Menüde arayıp bulmak gerekmez.
 */
export function ToolGrid({ sections }: { sections: ToolSection[] }) {
  return (
    <>
      {sections
        .filter((section) => section.tools.length > 0)
        .map((section) => (
          <div className="sp-tool-section" key={section.title}>
            <p className="sp-tool-section-title">{section.title}</p>
            <div className="sp-tile-grid">
              {section.tools.map((tool) => (
                <ToolTile key={tool.key} tool={tool} />
              ))}
            </div>
          </div>
        ))}
    </>
  );
}
