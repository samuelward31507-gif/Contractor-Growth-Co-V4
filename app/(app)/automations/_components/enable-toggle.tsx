"use client";

import { useState, useTransition } from "react";
import { setAutomationEnabled } from "../actions";

/**
 * Enable/disable toggle (Phase G) - only ever rendered for org admins (the
 * page checks membership.role before rendering this at all) and never for
 * the safety-layer automation (setAutomationEnabled itself also rejects
 * that server-side). This component's `enabled` prop is the real,
 * server-fetched automation_settings value - never a fake, frontend-only
 * state; every click calls the server action and reflects only what it
 * actually persisted, via a full page data refresh (revalidatePath inside
 * setAutomationEnabled), not local optimistic state.
 */
export function EnableToggle({ automationId, enabled }: { automationId: string; enabled: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function commit(nextEnabled: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setAutomationEnabled(automationId, nextEnabled);
      if (result.error) {
        setError(result.error);
      }
      setConfirming(false);
    });
  }

  function handleClick() {
    if (enabled && !confirming) {
      // Disabling stops new work going forward, but does not cancel
      // anything already in flight - worth a confirmation step; re-enabling
      // is fully reversible and needs none.
      setConfirming(true);
      return;
    }
    commit(!enabled);
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleClick}
          disabled={isPending}
          className={
            enabled
              ? "rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              : "rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
          }
        >
          {isPending ? "Saving…" : confirming ? "Confirm disable?" : enabled ? "Disable" : "Enable"}
        </button>
        {confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isPending}
            className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {confirming ? (
        <p className="text-xs text-slate-500">New events won&apos;t be created, but anything already in progress will still finish.</p>
      ) : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
