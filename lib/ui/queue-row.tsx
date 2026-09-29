import Link from "next/link";
import { Phone } from "lucide-react";
import { STATUS_STYLES, type StatusTone } from "./status";
import { StatusDot, type StatusDotTone } from "./status-dot";
import { ghostButtonClass, secondaryButtonSmallClass } from "./form";

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
}) {
  const style = STATUS_STYLES[tone];

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
