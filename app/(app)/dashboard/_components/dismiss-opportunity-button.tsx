"use client";

import { useState, useTransition } from "react";
import { dismissOpportunity } from "../actions";

/**
 * Pass 3 (Revenue Intelligence Foundation): the opportunity-backed sibling
 * of IncidentActions (app/(app)/automations/_components/incident-actions.tsx)
 * - same "resolvable in place" shape: an inline button that calls a plain
 * server action directly (not a form/useActionState), shows a static label
 * once acted on rather than removing itself from the list immediately (the
 * row itself disappears on the next dashboard load, once
 * dismissOpportunity's own revalidatePath("/dashboard") takes effect).
 */
export function DismissOpportunityButton({ opportunityId }: { opportunityId: string }) {
  const [isPending, startTransition] = useTransition();
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleDismiss() {
    startTransition(async () => {
      const result = await dismissOpportunity(opportunityId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setDismissed(true);
    });
  }

  if (dismissed) {
    return <span className="text-xs text-slate-500">Dismissed</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleDismiss}
        disabled={isPending}
        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Dismissing…" : "Dismiss"}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
