import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The one card/section container every Agency Command Center section is
 * built from (Overview, Client Health, Attention, Automation, AI) - local
 * to app/agency/, not a shared app-wide primitive, so this polish pass
 * cannot affect any other Trackpr page.
 */
export function SectionCard({
  title,
  description,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          {Icon ? (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100">
              <Icon className="h-4 w-4 text-slate-500" aria-hidden />
            </span>
          ) : null}
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
