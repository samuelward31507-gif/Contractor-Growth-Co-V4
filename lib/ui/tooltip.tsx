import type { ReactNode } from "react";

/**
 * UI/UX redesign pass: the one tooltip primitive for the whole app -
 * formalizes the exact hover/focus pattern the collapsed sidebar's own nav
 * items already hand-rolled (group/tip + opacity-0 group-hover:opacity-100),
 * now reusable anywhere a compact, icon-only control needs a labelled
 * hint. Pure CSS (no JS positioning library, no client component) - the
 * tooltip is always anchored to its trigger's own edge, which is all every
 * real usage in this app needs (a rail-mode nav icon, an icon-only table
 * action). Shows on hover AND keyboard focus, never on touch (no tap-to-show
 * affordance is added, since the label is always supplemented by a real
 * aria-label on the trigger for touch/screen-reader users either way).
 */
export function Tooltip({ label, side = "right", children }: { label: string; side?: "right" | "top"; children: ReactNode }) {
  const positionClass =
    side === "right"
      ? "left-full top-1/2 ml-2 -translate-y-1/2"
      : "bottom-full left-1/2 mb-2 -translate-x-1/2";

  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-white opacity-0 shadow-popover transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 ${positionClass}`}
      >
        {label}
      </span>
    </span>
  );
}
