/**
 * The one bordered-container primitive for the whole app - replaces the
 * deleted lib/ui/card.ts (never given a real successor; pages either
 * inlined their own copy or leaned on ad-hoc markup) and generalizes
 * app/agency/_components/section-card.tsx (a good pattern that was only
 * ever local to the agency routes) so every route shares it. `rounded-lg`
 * is the deliberate "container" tier of the app's radius scale - one step
 * up from the `rounded-lg` used by inputs/buttons/small controls, so a
 * panel always reads as a level "above" the controls inside it.
 *
 * Trackpr 2.0 full redesign: this is "Level 3" of the app's three-level
 * containment model (page canvas -> flush/divider grouping -> Panel) -
 * reserved for content that genuinely benefits from a contained surface
 * (a form, a table with its own toolbar), never the default wrapper for
 * "a section." `shadow-sm` is gone: the app shell's canvas background
 * (--canvas, globals.css) now sits one step off this component's white, so
 * a Panel already reads as a lifted surface through that background
 * contrast plus its hairline border - a drop shadow on top of that read as
 * exactly the "generic dashboard template" look the redesign brief called
 * out to avoid.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SectionCard({
  title,
  description,
  icon: Icon,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-4 sm:p-5 ${className}`}>
      {title ? (
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            {Icon ? (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset">
                <Icon className="h-3.5 w-3.5 text-ink-3" aria-hidden />
              </span>
            ) : null}
            <div>
              <h2 className="text-sm font-semibold text-ink">{title}</h2>
              {description ? <p className="mt-0.5 text-xs text-ink-3">{description}</p> : null}
            </div>
          </div>
          {action}
        </div>
      ) : null}
      <div className={title ? "mt-3" : undefined}>{children}</div>
    </section>
  );
}

/** A bare bordered container with no header - for content that builds its own heading (e.g. a page section that already has an <h2> above it via primarySectionTitleClass). */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-surface p-4 sm:p-5 ${className}`}>{children}</div>;
}
