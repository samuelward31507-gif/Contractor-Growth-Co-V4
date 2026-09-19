/**
 * The one bordered-container primitive for the whole app - replaces the
 * deleted lib/ui/card.ts (never given a real successor; pages either
 * inlined their own copy or leaned on ad-hoc markup) and generalizes
 * app/agency/_components/section-card.tsx (a good pattern that was only
 * ever local to the agency routes) so every route shares it. `rounded-xl`
 * is the deliberate "container" tier of the app's radius scale - one step
 * up from the `rounded-lg` used by inputs/buttons/small controls, so a
 * panel always reads as a level "above" the controls inside it.
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
    <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}>
      {title ? (
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            {Icon ? (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100">
                <Icon className="h-3.5 w-3.5 text-slate-500" aria-hidden />
              </span>
            ) : null}
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
              {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
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
  return <div className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}>{children}</div>;
}
