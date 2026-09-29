import Link from "next/link";
import type { ReactNode } from "react";

/**
 * UI/UX redesign pass: the one dense-table primitive for the whole app,
 * extracted from the pattern PeopleTable/EstimatesTable/JobsTable each
 * independently hand-rolled (a header row of grey 12px labels, a
 * `divide-y` list of rows, each row a full-width Link with a hover
 * background) - real, working markup, just never named as a shared
 * component before, so each list page's density/spacing could quietly
 * drift from the others. This does not replace any table's own columns or
 * data - only the shell each one renders inside, so "every page feels like
 * the same product" holds by construction rather than by convention.
 *
 * Desktop-only by design: every real consumer already renders its own
 * separate mobile list below `lg:hidden` (the row density that makes a
 * table valuable on a 1440px screen is exactly what makes it unusable at
 * 390px) - this component doesn't try to solve both, it's the desktop half
 * of that established pattern.
 */
export function Table({ columns, children, className = "" }: { columns: string; children: ReactNode; className?: string }) {
  return (
    <div className={`hidden lg:block ${className}`}>
      <div className={`grid ${columns} gap-6 border-b border-line px-2 pb-2.5`}>{children}</div>
    </div>
  );
}

export function TableHeadCell({ children, align = "left" }: { children?: ReactNode; align?: "left" | "right" }) {
  return <span className={`text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3 ${align === "right" ? "text-right" : ""}`}>{children}</span>;
}

/** The scrollable/divided row list beneath a Table's header - a separate component (not nested inside Table) so a page can render its own header once and a filtered/empty row list independently. */
export function TableBody({ children }: { children: ReactNode }) {
  return <div className="hidden divide-y divide-line lg:block">{children}</div>;
}

const ROW_TONE_RAIL: Record<"neutral" | "urgent" | "warning" | "success", string> = {
  neutral: "border-l-transparent",
  urgent: "border-l-danger",
  warning: "border-l-warning",
  success: "border-l-accent",
};

/**
 * One dense table row, rendered as a single full-width Link (matching every
 * existing table's own "the whole row is the click target" convention) -
 * `href` is required because every current consumer's row IS a navigation
 * target; a non-navigable row (rare) should compose TableRowStatic instead.
 * `tone` drives only a 2px left rail, never the row's background/text -
 * "color communicates meaning, not decoration."
 */
export function TableRow({
  href,
  columns,
  tone = "neutral",
  children,
}: {
  href: string;
  columns: string;
  tone?: "neutral" | "urgent" | "warning" | "success";
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`group grid ${columns} items-center gap-6 border-l-2 py-3 pl-3 pr-2 transition-colors duration-150 hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${ROW_TONE_RAIL[tone]}`}
    >
      {children}
    </Link>
  );
}

export function TableCell({ children, muted = false, align = "left", className = "" }: { children?: ReactNode; muted?: boolean; align?: "left" | "right"; className?: string }) {
  return <span className={`min-w-0 truncate text-sm ${muted ? "text-ink-3" : "text-ink"} ${align === "right" ? "text-right tabular-nums" : ""} ${className}`}>{children}</span>;
}
