import type { ReactNode } from "react";
import { kpiDescriptionClass, kpiLabelClass, kpiValueClass, metaClass } from "@/lib/ui/typography";
import { cardClass } from "@/lib/ui/surface";

/**
 * Analytics' one visual system: every category is a bordered panel with a
 * header (title + the time scope its numbers cover), a row of at most four
 * primary metrics divided by hairlines (Today's former revenue panel
 * language), and an optional body for secondary metrics, breakdowns and a
 * single note. Presentation only - every value arrives pre-formatted from
 * the BI snapshot.
 */

export type Metric = {
  key: string;
  label: string;
  value: string;
  detail?: string | null;
  /** positive/negative colors a period-over-period detail; attention flags a figure that needs action. */
  tone?: "positive" | "negative" | "attention";
};

const DETAIL_TONE: Record<NonNullable<Metric["tone"]>, string> = {
  positive: "text-accent-text",
  negative: "text-danger-text",
  attention: "font-medium text-danger-text",
};

/** "last 30 days" -> "Last 30 days" for a scope tag. */
export function scopeLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** A sentence-length value ("Not enough data yet") would overflow a 26px figure cell - it drops to a quieter size instead. */
function isTextValue(value: string): boolean {
  return value.length > 10 && /[a-z]{3}/i.test(value);
}

export function Panel({ id, title, scope, children }: { id: string; title: string; scope?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 overflow-hidden ${cardClass}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <h2 id={id} className="text-[15px] font-semibold text-ink">
          {title}
        </h2>
        {scope ? <p className="shrink-0 text-right text-xs text-ink-3">{scope}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Up to four headline figures: two columns on phones, one row from md up. An odd last figure spans the phone row so no empty cell shows. */
export function PrimaryMetrics({ metrics }: { metrics: Metric[] }) {
  const columns = metrics.length >= 4 ? "md:grid-cols-4" : metrics.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2";
  return (
    <dl className={`grid grid-cols-2 gap-px bg-line ${columns}`}>
      {metrics.slice(0, 4).map((metric, index, shown) => (
        <div key={metric.key} className={`flex min-w-0 flex-col bg-surface px-4 py-4 sm:px-5 ${shown.length % 2 === 1 && index === shown.length - 1 ? "col-span-2 md:col-span-1" : ""}`}>
          <dt className={kpiLabelClass}>{metric.label}</dt>
          <dd className={isTextValue(metric.value) ? "mt-2 text-base font-semibold leading-snug text-ink-2" : kpiValueClass}>{metric.value}</dd>
          {metric.detail ? <dd className={`${kpiDescriptionClass} ${metric.tone ? DETAIL_TONE[metric.tone] : ""}`}>{metric.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** The panel's padded area under the primary row - secondary metrics, breakdowns, a chart and at most one note. */
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5 border-t border-line px-4 py-4 sm:px-5">{children}</div>;
}

/** The compact supporting grid: two columns on phones, up to six on desktop, 15px figures. */
export function SecondaryMetrics({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
      {metrics.map((metric) => (
        <div key={metric.key} className="min-w-0">
          <dt className="text-xs text-ink-3">{metric.label}</dt>
          <dd className={`mt-0.5 font-semibold tabular-nums ${isTextValue(metric.value) ? "text-[13px] text-ink-2" : "text-[15px] text-ink"}`}>{metric.value}</dd>
          {metric.detail ? <dd className={`mt-0.5 text-xs ${metric.tone ? DETAIL_TONE[metric.tone] : "text-ink-3"}`}>{metric.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** A labeled sub-block inside a panel (a breakdown, a chart, a differently-scoped group) - the label, an optional scope tag, then its content. */
export function PanelBlock({ label, scope, children }: { label: string; scope?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex items-baseline justify-between gap-3 text-xs font-medium text-ink-2">
        <span>{label}</span>
        {scope ? <span className="font-normal text-ink-3">{scope}</span> : null}
      </p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** Two breakdowns side by side from lg up, stacked below - each at the full width of its column. */
export function BreakdownGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">{children}</div>;
}

/** The one note a panel may carry. Detailed definitions live in "How these numbers are calculated". */
export function PanelNote({ children }: { children: ReactNode }) {
  return <p className={metaClass}>{children}</p>;
}
