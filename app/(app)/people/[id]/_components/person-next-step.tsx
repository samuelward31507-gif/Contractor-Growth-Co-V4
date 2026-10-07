import Link from "next/link";
import { AlertCircle, ArrowRight } from "lucide-react";
import type { NextStepView } from "@/lib/decisions/presentation";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { OwnerChip } from "@/lib/ui/owner-chip";

/**
 * Batch 3 (core daily loop): the Person page's one "what happens next"
 * answer - whose move it is (OwnerChip), what it is, and the way in. The
 * step is lib/people/next-step.ts's; the owner is the actor model's
 * (lib/decisions/presentation.ts), the same as Today, People and Inbox.
 */
export function PersonNextStep({ nextView, personName: name }: { nextView: NextStepView | null; personName: string }) {
  return (
    <section
      aria-labelledby="person-next"
      className={`flex flex-col gap-4 rounded-2xl border px-5 py-4 shadow-card sm:flex-row sm:items-center sm:justify-between ${
        nextView?.needsYou ? "border-warning-border bg-warning-muted" : nextView?.owner === "trackpr" ? "border-accent-border bg-surface" : "border-line bg-surface"
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            nextView?.needsYou ? "bg-surface text-warning-text" : nextView?.owner === "trackpr" ? "bg-accent-muted text-accent-text" : "bg-inset text-ink-3"
          }`}
        >
          {nextView?.needsYou ? <AlertCircle className="h-4 w-4" aria-hidden /> : <ArrowRight className="h-4 w-4" aria-hidden />}
        </span>
        <div className="min-w-0">
          <h2 id="person-next" className="text-xs font-medium text-ink-3">
            What happens next
          </h2>
          {nextView ? (
            <>
              <p className="mt-1 flex flex-wrap items-center gap-2">
                <OwnerChip owner={nextView.owner} urgent={nextView.needsYou} />
                <span className="text-[15px] font-semibold text-ink">{nextView.headline}</span>
              </p>
              {nextView.detail ? <p className="mt-0.5 text-sm text-ink-3">{nextView.detail}</p> : null}
              {nextView.owner !== "you" ? <p className="mt-0.5 text-xs text-ink-3">Nothing for you to do right now.</p> : null}
            </>
          ) : (
            <p className="mt-1 text-[15px] font-semibold text-ink">Nothing is in motion with {name} right now.</p>
          )}
        </div>
      </div>
      {nextView ? (
        <Link href={nextView.href} className={`${nextView.needsYou ? primaryButtonAutoClass : secondaryButtonAutoClass} shrink-0 self-start sm:self-auto`}>
          {nextView.owner === "you" ? "Open" : "See details"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      ) : null}
    </section>
  );
}
