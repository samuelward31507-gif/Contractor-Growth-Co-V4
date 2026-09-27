import Link from "next/link";
import { Phone } from "lucide-react";
import { cardTitleClass } from "./typography";
import { STATUS_STYLES, type StatusTone } from "./status";
import { secondaryButtonSmallClass, primaryButtonAutoClass } from "./form";

// Not composed from primaryButtonAutoClass/primaryButtonSmallClass: those
// tiers each carry their own min-height (52px mobile-only, 44px always,
// respectively), and stacking a third min-h-* utility on top of either
// depends on Tailwind's generated rule order rather than source order -
// fragile. The plan calls for this one button to be >=52px at every
// viewport (it's the single most important action on the card), which
// matches neither shared tier's own responsive behavior, so it gets its
// own explicit classes instead.
const callButtonClass =
  "inline-flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-6 text-base font-semibold text-accent-foreground transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 sm:flex-none";

/**
 * Phase 1 (components pass): the card the Today screen (Phase 2) is built
 * from. Anatomy, top to bottom - a status band naming the problem in plain
 * English (left) and its age (right), the person's name linked to their
 * detail page, the money at stake and the job type, one sentence
 * explaining why the card exists, then one primary action (Call, when a
 * phone number is available) plus one optional secondary.
 *
 * Deliberately a top band, not a left border - a left-border card is the
 * house style of generated UI; a top band reads like a work order, which
 * is the right reference for this audience.
 */
export function QueueCard({
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
  /** The problem, named in plain English - "Quote going cold," never the machine kind. */
  problemLabel: string;
  /**
   * How long this has been true - "9 days ago." Optional: not every
   * source this card is built from carries a real, structured timestamp
   * (an AttentionItem's own `detail` is a display string, not a parseable
   * date) - the band shows the problem alone rather than a guessed or
   * duplicated age when this is absent.
   */
  age?: string;
  personName: string;
  personHref: string;
  /** Formatted currency string, e.g. "$12,400" - omitted when no dollar figure applies. */
  money?: string;
  jobType?: string;
  /** The one sentence explaining why this card exists. */
  sentence: string;
  /** Raw phone number for the primary "Call" action - the card renders no primary action when this is absent. */
  phone?: string | null;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  const style = STATUS_STYLES[tone];
  const isSolidBand = tone === "urgent";

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className={`flex items-center justify-between gap-3 px-4 py-2 text-sm font-medium ${isSolidBand ? style.bandClass : `${style.tintClass}`}`}>
        <span>{problemLabel}</span>
        {age ? <span className={isSolidBand ? "text-white/80" : "opacity-70"}>{age}</span> : null}
      </div>

      <div className="p-5">
        <Link href={personHref} className={`${cardTitleClass} hover:underline`}>
          {personName}
        </Link>

        {money || jobType ? (
          <p className="mt-1 text-sm text-slate-600">
            {money ? <span className="font-semibold tabular-nums text-slate-900">{money}</span> : null}
            {money && jobType ? <span className="mx-1.5 text-slate-300">·</span> : null}
            {jobType ? <span>{jobType}</span> : null}
          </p>
        ) : null}

        <p className="mt-3 text-sm text-slate-600">{sentence}</p>

        {phone || secondaryHref ? (
          <div className="mt-4 flex items-center gap-3">
            {phone ? (
              <a href={`tel:${phone}`} className={callButtonClass}>
                <Phone className="h-4 w-4" aria-hidden />
                Call
              </a>
            ) : null}
            {secondaryHref && secondaryLabel ? (
              // No phone number available for this item (see the caller's
              // own comment on why - not every source this card is built
              // from carries a contact reference) - promoted to the primary
              // tier so the card never leaves a single available action
              // under-emphasized next to an absent one.
              <Link href={secondaryHref} className={phone ? secondaryButtonSmallClass : `${primaryButtonAutoClass} flex-1 sm:flex-none`}>
                {secondaryLabel}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
