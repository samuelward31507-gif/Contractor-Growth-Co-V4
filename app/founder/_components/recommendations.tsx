import Link from "next/link";
import { ArrowRight, Lightbulb } from "lucide-react";
import { primaryButtonAutoClass } from "@/lib/ui/form";
import type { Recommendation } from "@/lib/founder/intelligence";

const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/** The inference, always labelled - never blended into the fact above it. */
function Suggestion({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs text-ink-3">
      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-ink-2">Suggestion:</span> {text}
      </span>
    </p>
  );
}

/**
 * The single highest-ranked recommendation, at the top of the home page.
 * `why` is the stored fact that triggered it; `suggestion` is the inference.
 */
export function NextBestAction({ action }: { action: Recommendation | null }) {
  if (!action) {
    return (
      <section aria-labelledby="next-best-action" className="rounded-xl border border-line bg-surface px-4 py-3">
        <h2 id="next-best-action" className="text-xs font-semibold uppercase tracking-wide text-ink-3">Next best action</h2>
        <p className="mt-1 text-sm text-ink-2">Nothing is pressing: no open priorities, nothing overdue or due soon, and every open deal has a next step.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="next-best-action" className="rounded-xl border border-accent-border bg-accent-muted px-4 py-3" data-rule={action.rule}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="next-best-action" className="text-xs font-semibold uppercase tracking-wide text-ink-3">Next best action</h2>
          <p className="mt-1 text-base font-semibold text-ink">{action.title}</p>
          <p className="mt-0.5 text-sm text-ink-2">
            <span className="sr-only">Why: </span>
            {action.why}
          </p>
          <Suggestion text={action.suggestion} />
        </div>
        <Link href={action.href} className={`${primaryButtonAutoClass} shrink-0 gap-1.5 self-start`}>
          Open
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

/** The rest of the ranked recommendations, each with its reason and where to act. */
export function RecommendationList({ recommendations }: { recommendations: Recommendation[] }) {
  return (
    <ol className="divide-y divide-line">
      {recommendations.map((rec) => (
        <li key={rec.id} className="py-2.5" data-rule={rec.rule}>
          <Link href={rec.href} className={`group block rounded-sm ${FOCUS}`}>
            <span className="block text-sm font-medium text-ink group-hover:underline">{rec.title}</span>
            <span className="mt-0.5 block text-xs text-ink-3">{rec.why}</span>
          </Link>
          <Suggestion text={rec.suggestion} />
        </li>
      ))}
    </ol>
  );
}
