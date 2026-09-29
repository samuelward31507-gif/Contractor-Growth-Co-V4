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
              ? "rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/10 disabled:cursor-not-allowed disabled:opacity-40"
              : "rounded-lg border border-accent-border bg-accent-muted px-3 py-1.5 text-xs font-medium text-accent-text transition-colors hover:bg-accent-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
          }
        >
          {isPending ? "Saving…" : confirming ? "Confirm disable?" : enabled ? "Disable" : "Enable"}
        </button>
        {confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isPending}
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-ink-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {confirming ? (
        <p className="text-xs text-ink-3">New events won&apos;t be created, but anything already in progress will still finish.</p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
