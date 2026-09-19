"use client";

import { useState, useTransition } from "react";
import { runAutomationNow, dryRunAutomation } from "../actions";
import type { ReminderPreview } from "@/lib/automation/appointment-reminders";
import type { FollowupPreview } from "@/lib/automation/estimate-followups";

function describePreview(preview: ReminderPreview | FollowupPreview | undefined): string {
  if (!preview) return "No preview available.";
  switch (preview.outcome) {
    case "would_send":
      return `Would send: "${preview.body}"`;
    case "would_expire":
      return "Would mark an estimate expired - no message would be sent.";
    case "no_candidates":
      return "Nothing is due right now.";
    case "no_contact":
      return "A candidate is due, but has no contact on file.";
    case "contact_opted_out":
      return "A candidate is due, but the contact has opted out of texts.";
    default:
      return "No preview available.";
  }
}

/**
 * Manual Run + Dry Run controls (Phase D) - only ever rendered by the
 * detail page for the two Trackpr-dispatched automations (see that page's
 * own dispatch === "trackpr" check). Both buttons call a server action that
 * independently re-validates the automation id against its own allowlist,
 * re-checks org-admin authorization, and re-checks enabled state - this
 * component's `enabled` prop only controls the disabled visual state, it is
 * never trusted as the actual authorization.
 */
export function ManualRunControls({ automationId, enabled }: { automationId: string; enabled: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleRun() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await runAutomationNow(automationId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setMessage(result.auditWarning ? `Run started. ${result.auditWarning}` : "Run started - check Recent Executions below.");
    });
  }

  function handleDryRun() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await dryRunAutomation(automationId);
      if (result.error) {
        setError(result.error);
        return;
      }
      const preview = describePreview(result.preview);
      setMessage(result.auditWarning ? `${preview} ${result.auditWarning}` : preview);
    });
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleRun}
          disabled={!enabled || isPending}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {isPending ? "Working…" : "Run now"}
        </button>
        <button
          type="button"
          onClick={handleDryRun}
          disabled={!enabled || isPending}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {isPending ? "Working…" : "Test / dry run"}
        </button>
        {!enabled ? <span className="text-xs text-slate-400">Disabled - re-enable this automation to run or test it.</span> : null}
      </div>
      {message ? <p className="text-xs text-emerald-700">{message}</p> : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
