/**
 * The one page-header primitive - eyebrow, title, description, and an
 * optional right-aligned action/status slot. Every top-level route
 * (Dashboard, Leads, Contacts, Appointments, etc.) previously hand-rolled
 * this exact `<h1>`/`<p>` pair inline; this is the shared version so
 * title/description spacing never drifts between routes.
 *
 * `eyebrow` (usually the page's own sidebar group - "Operate", "Automate",
 * "Insights", "System") is the same small-caps, wide-tracking, emerald label
 * convention the marketing site uses above its own section headlines (see
 * app/(marketing)/_components/section.tsx's Eyebrow) - a single, cheap
 * addition here threads that typographic signature through every page in
 * the product without touching each page's own markup beyond passing a
 * string. Deliberately does not own page padding/layout - callers keep their
 * own `<div className="flex flex-1 flex-col gap-6 px-4 py-6 ...">` wrapper,
 * since that padding rhythm is the page shell's concern, not the header's.
 */
import type { ReactNode } from "react";
import { pageTitleClass, pageDescriptionClass } from "./typography";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  badge,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        {eyebrow ? <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">{eyebrow}</p> : null}
        <div className="flex items-center gap-2.5">
          <h1 className={pageTitleClass}>{title}</h1>
          {badge}
        </div>
        {description ? <p className={`mt-1.5 ${pageDescriptionClass}`}>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
