import Link from "next/link";
import { ArrowRight, Phone } from "lucide-react";
import { STATUS_STYLES, type StatusTone } from "./status";
import { StatusDot, type StatusDotTone } from "./status-dot";
import { ghostButtonClass, secondaryButtonSmallClass } from "./form";

/** Tone text on the dark plane - the lighter steps of the same status families. */
const INVERSE_TONE_TEXT: Record<StatusTone, string> = {
  urgent: "text-danger-on-dark",
  soon: "text-warning-on-dark",
  good: "text-accent-on-dark",
  done: "text-on-dark-3",
};

const DOT_TONE: Record<StatusTone, StatusDotTone> = {
  urgent: "critical",
  soon: "attention",
  good: "healthy",
  done: "neutral",
};

/**
 * Trackpr 2.0 (step 2E): one row of the Dashboard's "Needs your attention"
 * list - an operational list row, not a card. Who and what on the first
 * line, why in one sentence, the value and the next step on the right. The
 * tone shows as a small dot beside the problem label, never as color alone
 * (the label always names it). Same props as before, so the data mapping
 * on the page is unchanged.
 *
 * Final redesign: `variant="inverse"` renders the same row for the dark
 * attention panel - always stacked (the panel is a narrow column), as a
 * faint inset tile: who (and the value), what happened (tone + age), why it
 * matters (the sentence), then the next action as a pine link and the
 * person's record as "Open". Same props, same links, same data.
 */
export function QueueRow({
  tone,
  problemLabel,
  age,
  personName,
  personHref,
  money,
  jobType,
  sentence,
  phone,
  secondaryHref,
  secondaryLabel,
  variant = "default",
}: {
  tone: StatusTone;
  problemLabel: string;
  age?: string;
  personName: string;
  personHref: string;
  money?: string;
  jobType?: string;
  sentence: string;
  phone?: string | null;
  secondaryHref?: string;
  secondaryLabel?: string;
  /** "inverse" = the dark attention panel's stacked tile. */
  variant?: "default" | "inverse";
}) {
  const style = STATUS_STYLES[tone];

  if (variant === "inverse") {
    return (
      <div className="rounded-lg bg-dark-fill px-4 py-3.5 inset-ring inset-ring-dark-line transition-colors duration-150 hover:bg-dark-fill-strong">
        <div className="flex items-baseline justify-between gap-3">
          <Link href={personHref} className="-my-3 truncate py-3 text-sm font-semibold text-on-dark hover:underline focus:outline-none focus-visible:underline sm:my-0 sm:py-0">
            {personName}
          </Link>
          {money ? <span className="shrink-0 text-sm font-semibold tabular-nums text-on-dark">{money}</span> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span className={`inline-flex items-center gap-1.5 font-medium ${INVERSE_TONE_TEXT[tone]}`}>
            <StatusDot tone={DOT_TONE[tone]} />
            {problemLabel}
          </span>
          {age ? <span className="text-on-dark-3">· {age}</span> : null}
          {jobType ? <span className="text-on-dark-3">· {jobType}</span> : null}
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-on-dark-2">{sentence}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          {secondaryHref && secondaryLabel ? (
            <Link
              href={secondaryHref}
              className="-my-2 inline-flex min-h-11 min-w-0 items-center gap-1 rounded py-2 text-[13px] font-medium text-accent-on-dark hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-on-dark/50 sm:my-0 sm:min-h-0 sm:py-0"
            >
              <span className="truncate">{secondaryLabel}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
            </Link>
          ) : (
            <span />
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {phone ? (
              <a
                href={`tel:${phone}`}
                aria-label={`Call ${personName}`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-on-dark-2 transition-colors hover:bg-dark-fill-strong hover:text-on-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-on-dark/50 sm:min-h-8"
              >
                <Phone className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                Call
              </a>
            ) : null}
            <Link
              href={personHref}
              aria-label={`Open ${personName}`}
              className="inline-flex min-h-11 items-center rounded-lg border border-white/15 bg-dark-fill px-3 text-xs font-medium text-on-dark transition-colors hover:border-white/25 hover:bg-dark-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-on-dark/50 sm:min-h-8"
            >
              Open
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-6 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          {/* -my-3/py-3 grows the tap area to 44px on touch without moving the layout. */}
          <Link href={personHref} className="-my-3 truncate py-3 text-sm font-semibold text-ink hover:underline focus:outline-none focus-visible:underline sm:my-0 sm:py-0">
            {personName}
          </Link>
          {money ? <span className="shrink-0 text-sm font-semibold tabular-nums text-ink sm:hidden">{money}</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span className={`inline-flex items-center gap-1.5 font-medium ${style.textClass}`}>
            <StatusDot tone={DOT_TONE[tone]} />
            {problemLabel}
          </span>
          {age ? <span className="text-ink-3">· {age}</span> : null}
          {jobType ? <span className="text-ink-3">· {jobType}</span> : null}
        </div>
        <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-ink-2 sm:line-clamp-1">{sentence}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {money ? <span className="hidden w-20 text-right text-sm font-semibold tabular-nums text-ink sm:block">{money}</span> : null}
        {phone ? (
          <a href={`tel:${phone}`} aria-label={`Call ${personName}`} className={`${ghostButtonClass} sm:min-h-8 sm:px-2.5 sm:text-xs`}>
            <Phone className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            Call
          </a>
        ) : null}
        {secondaryHref && secondaryLabel ? (
          <Link href={secondaryHref} className={`${secondaryButtonSmallClass} flex-1 sm:flex-none`}>
            {secondaryLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
