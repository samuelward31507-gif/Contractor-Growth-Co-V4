import type { ReactNode } from "react";
import { cardClass } from "@/lib/ui/surface";
import { monoCountClass, primarySectionTitleClass } from "@/lib/ui/typography";

/**
 * Agency overview redesign: one titled card section, the same shape as the
 * client app's card sections (app/(app)/today/_components/dashboard-sections.tsx's
 * DashboardSection variant="card" and HappeningToday) - a real <h2> inside
 * the card, an optional mono count pill and right-aligned action, and a body
 * that runs edge to edge so list rows and tables reach the card's own edge.
 * `aria-labelledby` ties the section landmark to its heading.
 */
export function AgencySection({
  id,
  title,
  description,
  count,
  action,
  children,
  className = "",
}: {
  id: string;
  title: string;
  description?: string;
  /** A real count of what the section lists - omitted entirely when there is nothing to count. */
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`min-w-0 overflow-hidden ${cardClass} ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 id={id} className={primarySectionTitleClass}>
              {title}
            </h2>
            {count !== undefined ? (
              <span className={`inline-flex shrink-0 items-center rounded-full bg-inset px-2 py-0.5 text-ink-2 inset-ring inset-ring-line ${monoCountClass}`}>{count}</span>
            ) : null}
          </div>
          {description ? <p className="mt-0.5 text-xs text-ink-3">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
