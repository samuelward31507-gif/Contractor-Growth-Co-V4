import type { ReactNode } from "react";

/**
 * Agency Command Center UI review: the label/value row this whole redesign
 * is built from, replacing the old stat-grid.tsx card-wall (every number in
 * its own bordered box, all given identical visual weight). Mirrors
 * app/(app)/dashboard/_components/business-glance.tsx's own local Row
 * function exactly (same layout, same type scale) - kept as its own small
 * copy here rather than imported, since that file belongs to the client
 * dashboard and this task does not touch client CRM components.
 */
export function Row({ label, value, tone = "default", description }: { label: string; value: ReactNode; tone?: "default" | "danger" | "warning" | "success"; description?: string }) {
  const valueClass =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "success" ? "text-accent-text" : "text-ink";

  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-sm text-ink-2">{label}</span>
      <span className="text-right">
        <span className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</span>
        {description ? <span className="ml-1.5 text-xs text-ink-3">{description}</span> : null}
      </span>
    </div>
  );
}

export function RowGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <div className="mt-1.5 divide-y divide-line">{children}</div>
    </div>
  );
}
