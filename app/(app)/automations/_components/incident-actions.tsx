"use client";

import { useState, useTransition } from "react";
import { acknowledgeIncident, resolveIncident } from "../health-actions";
import type { IncidentStatus } from "@/lib/automation-health/types";

/**
 * Manual acknowledge/resolve controls - only rendered for an open/
 * acknowledged incident (see IncidentList). The two server actions
 * independently re-verify owner/admin authorization via
 * acknowledge_automation_incident/resolve_automation_incident regardless of
 * who can see this button rendered, matching RetryButton's own established
 * "client-side rendering is a heuristic, the server re-checks everything"
 * pattern.
 */
export function IncidentActions({ incidentId, status }: { incidentId: string; status: IncidentStatus }) {
  const [isPending, startTransition] = useTransition();
  const [localStatus, setLocalStatus] = useState<IncidentStatus>(status);
  const [error, setError] = useState<string | null>(null);

  function handleAcknowledge() {
    startTransition(async () => {
      const result = await acknowledgeIncident(incidentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setLocalStatus(result.incident.status);
    });
  }

  function handleResolve() {
    startTransition(async () => {
      const result = await resolveIncident(incidentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setLocalStatus(result.incident.status);
    });
  }

  if (localStatus === "resolved") {
    return <span className="text-xs text-emerald-700">Resolved</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1.5">
        {localStatus === "open" ? (
          <button
            type="button"
            onClick={handleAcknowledge}
            disabled={isPending}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending ? "Acknowledging…" : "Acknowledge"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleResolve}
          disabled={isPending}
          className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-900/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Resolving…" : "Resolve"}
        </button>
      </div>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
