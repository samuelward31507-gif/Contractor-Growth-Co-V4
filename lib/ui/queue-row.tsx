import Link from "next/link";
import { Phone } from "lucide-react";
import { STATUS_STYLES, type StatusTone } from "./status";
import { secondaryButtonSmallClass, primaryButtonSmallClass } from "./form";

const RAIL_CLASS: Record<StatusTone, string> = {
  urgent: "border-l-danger",
  soon: "border-l-warning",
  good: "border-l-accent",
  done: "border-l-transparent",
};

/**
 * Redesign pass: the replacement for QueueCard's bordered-box-in-a-grid
 * layout (still used unchanged by lib/ui/queue-card.tsx's own remaining
 * consumers, if any) on Today - "a dense, elegant list/feed rather than
 * giant cards" is the exact brief this satisfies. Same information, same
 * props even (name/value/problem/age/sentence/phone/secondary action) - only
 * the shell changes: one full-width row in a divided list, a 2px tone rail
 * instead of a solid color band, name and value on the same line so the
 * reader never has to hunt for either.
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
    <div className={`flex flex-col gap-2 border-l-2 py-4 pl-4 pr-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:pr-4 ${RAIL_CLASS[tone]}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <Link href={personHref} className="truncate text-[15px] font-semibold text-slate-900 hover:underline">
            {personName}
          </Link>
          {money ? <span className="shrink-0 text-[15px] font-semibold tabular-nums text-slate-900 sm:hidden">{money}</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span className={`font-medium ${style.textClass}`}>{problemLabel}</span>
          {age ? <span className="text-slate-400">· {age}</span> : null}
          {jobType ? <span className="text-slate-400">· {jobType}</span> : null}
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm text-slate-600 sm:line-clamp-1">{sentence}</p>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-start sm:gap-2">
        {money ? <span className="hidden text-[15px] font-semibold tabular-nums text-slate-900 sm:block">{money}</span> : null}
        {phone || secondaryHref ? (
          <div className="flex items-center gap-2">
            {phone ? (
              <a href={`tel:${phone}`} className={primaryButtonSmallClass}>
                <Phone className="h-3.5 w-3.5" aria-hidden />
                Call
              </a>
            ) : null}
            {secondaryHref && secondaryLabel ? (
              <Link href={secondaryHref} className={secondaryButtonSmallClass}>
                {secondaryLabel}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
