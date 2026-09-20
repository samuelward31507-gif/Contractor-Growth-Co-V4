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
    tone === "danger" ? "text-red-600" : tone === "warning" ? "text-amber-600" : tone === "success" ? "text-accent-text" : "text-slate-900";

  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="text-right">
        <span className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</span>
        {description ? <span className="ml-1.5 text-xs text-slate-400">{description}</span> : null}
      </span>
    </div>
  );
}

export function RowGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="mt-1.5 divide-y divide-slate-100">{children}</div>
    </div>
  );
}
