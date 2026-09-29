"use client";

import { useActionState } from "react";
import { errorBannerClass, secondaryButtonSmallClass } from "@/lib/ui/form";
import { generateDashboardInsights, type GenerateInsightsState } from "../actions";

const initialState: GenerateInsightsState = {};

/**
 * Isolated client component: the ONLY thing on the dashboard that ever
 * triggers app/(app)/dashboard/actions.ts's generateDashboardInsights - a
 * deliberate click, never a page render. Kept as its own small component so
 * a failure here (shown inline, below) can never affect the rest of the
 * already-rendered server-rendered dashboard around it.
 */
export function GenerateInsightsButton({ label }: { label: string }) {
  const [state, formAction, isPending] = useActionState(generateDashboardInsights, initialState);

  return (
    <div className="flex flex-col items-end gap-2">
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          className={secondaryButtonSmallClass}
        >
          {isPending ? "Generating…" : label}
        </button>
      </form>
      {state.error ? <p className={`${errorBannerClass} text-xs`} role="alert">{state.error}</p> : null}
    </div>
  );
}
