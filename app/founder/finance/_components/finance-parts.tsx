import Link from "next/link";
import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import { formatFinanceMoney, totalsList, type AttentionItem, type CurrencyTotals } from "@/lib/founder/finance";

/** Overview / Records switcher shared by both finance pages. */
export function FinanceTabs({ active }: { active: "overview" | "records" }) {
  return (
    <nav aria-label="Finance" className={segmentedTrackClass}>
      <Link href="/founder/finance" aria-current={active === "overview" ? "page" : undefined} className={segmentedItemClass(active === "overview")}>
        Overview
      </Link>
      <Link href="/founder/finance/records" aria-current={active === "records" ? "page" : undefined} className={segmentedItemClass(active === "records")}>
        Records
      </Link>
    </nav>
  );
}

/**
 * Per-currency figures stacked, one line each - never added together. USD
 * (the billing currency, the one with a verified Stripe format) leads, the
 * rest follow alphabetically, and with several currencies every line is the
 * same size: no currency is presented as the headline over another.
 */
export function Amounts({ totals, empty = "—", size = "md" }: { totals: CurrencyTotals; empty?: string; size?: "md" | "lg" }) {
  const list = totalsList(totals).sort((a, b) => (a.currency === "USD" ? -1 : b.currency === "USD" ? 1 : 0));
  if (!list.length) return <span className="text-ink-3">{empty}</span>;
  const lineClass = size === "lg" && list.length > 1 ? "text-[20px] leading-tight sm:text-[22px]" : "";
  return (
    <span className="flex flex-col gap-1">
      {list.map(({ currency, amount }) => (
        <span key={currency} className={lineClass}>
          <Money value={amount} currency={currency} />
        </span>
      ))}
    </span>
  );
}

export function Money({ value, currency, signed = false }: { value: number; currency: string; signed?: boolean }) {
  const text = formatFinanceMoney(Math.abs(value), currency);
  const sign = signed && value !== 0 ? (value > 0 ? "+" : "−") : value < 0 ? "−" : "";
  return <span className={`tabular-nums ${signed && value < 0 ? "text-danger-text" : ""}`}>{`${sign}${text}`}</span>;
}

/** A section heading with its one-line explanation, outside a card - the page reads top to bottom. */
export function FinanceSection({ id, title, description, action, children }: { id?: string; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={id ? `${id}-title` : undefined} className="text-base font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h2>
          {description ? <p className="mt-0.5 max-w-3xl text-sm text-ink-3">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A labelled figure inside a panel - smaller than a KPI card. */
export function Figure({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-3">{label}</dt>
      <dd className="mt-1 text-[15px] font-semibold text-ink">{children}</dd>
      {note ? <dd className="mt-0.5 text-xs text-ink-3">{note}</dd> : null}
    </div>
  );
}

/** "Not enough data" said plainly, with what's missing - never a zero that looks real. */
export function Insufficient({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line-strong bg-inset/60 px-3 py-2.5 text-sm text-ink-3">{children}</p>;
}

const ATTENTION_STYLE: Record<AttentionItem["tone"], { icon: typeof AlertCircle; className: string; label: string }> = {
  danger: { icon: AlertCircle, className: "text-danger", label: "Urgent" },
  warning: { icon: AlertTriangle, className: "text-warning", label: "Check" },
  info: { icon: Info, className: "text-ink-3", label: "Note" },
};

export function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {items.map((item) => {
        const style = ATTENTION_STYLE[item.tone];
        const Icon = style.icon;
        const body = (
          <>
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.className}`} aria-label={style.label} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{item.title}</span>
              <span className="mt-0.5 block text-xs text-ink-3">{item.detail}</span>
            </span>
          </>
        );
        return (
          <li key={item.id}>
            {item.href ? (
              <Link href={item.href} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-hover focus:outline-none focus-visible:bg-hover">
                {body}
                <span className="shrink-0 self-center text-xs font-medium text-ink-3">Open</span>
              </Link>
            ) : (
              <div className="flex items-start gap-3 px-4 py-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function SourceTag({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-ink-3">{children}</span>;
}
