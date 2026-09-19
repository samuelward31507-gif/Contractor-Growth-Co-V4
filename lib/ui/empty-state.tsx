/**
 * The one empty-state primitive for the whole app. Every list/detail page
 * previously built its own (icon + heading + description) block with small
 * drift in spacing/wording style - this consolidates them. Per the design
 * brief: an empty state must always tell the user what this area is, why
 * it's empty right now, and what to do next - `description` and `action`
 * exist specifically so no route can skip straight to a bare heading.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { surfaceClass } from "./surface";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className={`flex flex-col items-center gap-2 px-6 py-12 text-center ${surfaceClass}`}>
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm">
        <Icon className="h-5 w-5 text-slate-400" aria-hidden />
      </span>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="max-w-sm text-sm text-slate-500">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
