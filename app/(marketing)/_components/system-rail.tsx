/**
 * The one "connected system" visual primitive for the marketing site -
 * a row of icon nodes joined by a single through-line, not a grid of
 * disconnected cards. Reused by the Hero (compact, a handful of steps),
 * the System/Solution section (the full sequence), and /how-it-works.
 *
 * The line is a single absolutely-positioned bar (horizontal on desktop,
 * vertical on mobile) sitting BEHIND the row; each node's circle has an
 * opaque background and sits above it (z-10), so the line reads as
 * running "through" every node rather than floating separately - the
 * standard timeline-through-nodes construction, done in pure CSS with no
 * JS and no per-node absolute positioning math.
 */
import type { LucideIcon } from "lucide-react";

export type RailStep = {
  key: string;
  label: string;
  description?: string;
  icon: LucideIcon;
};

export function SystemRail({
  steps,
  tone = "dark",
  dense = false,
}: {
  steps: RailStep[];
  /** "dark" for the navy hero/system sections, "light" for white-background sections. */
  tone?: "dark" | "light";
  /** Smaller nodes/type for the compact hero preview. */
  dense?: boolean;
}) {
  const nodeBg = tone === "dark" ? "bg-slate-950" : "bg-white";
  const circleIdle = tone === "dark" ? "border-white/15 bg-white/[0.04] text-slate-400" : "border-slate-200 bg-white text-slate-400";
  const circleAccent = "border-emerald-500/40 bg-emerald-500/15 text-emerald-400";
  const lineColor = tone === "dark" ? "bg-white/10" : "bg-slate-200";
  const labelColor = tone === "dark" ? "text-white" : "text-slate-900";
  const descColor = tone === "dark" ? "text-slate-400" : "text-slate-500";
  const circleSize = dense ? "h-9 w-9" : "h-11 w-11";
  const iconSize = dense ? "h-4 w-4" : "h-[18px] w-[18px]";

  return (
    <ol className="relative flex flex-col gap-8 sm:flex-row sm:items-start sm:gap-0">
      {/* Mobile: a single vertical line behind the column of nodes. */}
      <span aria-hidden className={`absolute left-[19px] top-2 bottom-2 w-px sm:hidden ${lineColor}`} />
      {/* Desktop: a single horizontal line behind the row of nodes. */}
      <span
        aria-hidden
        className={`absolute hidden sm:block sm:left-0 sm:right-0 ${lineColor}`}
        style={{ top: dense ? 18 : 22, height: 1 }}
      />

      {steps.map((step, index) => (
        <li key={step.key} className="relative flex flex-1 items-start gap-4 sm:flex-col sm:items-center sm:gap-3 sm:px-2 sm:text-center">
          <span
            className={`relative z-10 flex shrink-0 items-center justify-center rounded-full border ${circleSize} ${
              index === 0 ? circleAccent : circleIdle
            } ${nodeBg}`}
          >
            <step.icon className={iconSize} aria-hidden />
          </span>
          <span className="min-w-0 pt-1 sm:pt-0">
            <span className={`block text-[11px] font-semibold uppercase tracking-wider ${descColor}`}>
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className={`mt-0.5 block text-sm font-semibold ${labelColor}`}>{step.label}</span>
            {step.description ? (
              <span className={`mt-1 block text-xs leading-relaxed ${descColor} sm:max-w-[9rem]`}>{step.description}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
