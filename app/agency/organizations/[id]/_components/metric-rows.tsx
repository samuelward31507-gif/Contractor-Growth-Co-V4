import type { ReactNode } from "react";

/**
 * Agency client detail (design-system pass): the label/value list used
 * inside this page's SectionCards. A real <dl> (each Row is one dt/dd pair)
 * so a screen reader announces "Failed, 3" rather than two loose strings.
 * Same tone vocabulary as app/agency/_components/row.tsx - tone colors the
 * value only, never the row - but kept local to this page so the shared
 * agency Row (used by pages other engineers own) is not changed.
 */
export type RowTone = "default" | "danger" | "warning" | "success";

const VALUE_TONE: Record<RowTone, string> = {
  default: "text-ink",
  danger: "text-danger-text",
  warning: "text-warning-text",
  success: "text-accent-text",
};

export function MetricList({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      {label ? <h3 className="text-xs font-medium text-ink-3">{label}</h3> : null}
      <dl className={`divide-y divide-line ${label ? "mt-1" : ""}`}>{children}</dl>
    </div>
  );
}

export function Row({ label, value, tone = "default", description }: { label: string; value: ReactNode; tone?: RowTone; description?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="min-w-0 text-sm text-ink-2">{label}</dt>
      <dd className="min-w-0 max-w-[60%] text-right">
        <span className={`text-sm font-semibold tabular-nums ${VALUE_TONE[tone]}`}>{value}</span>
        {description ? <span className="mt-0.5 block break-words text-xs text-ink-3">{description}</span> : null}
      </dd>
    </div>
  );
}
