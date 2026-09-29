"use client";

import { useState, useTransition } from "react";
import { acknowledgeIncident, resolveIncident } from "../health-actions";
import type { IncidentStatus } from "@/lib/automation-health/types";
import { secondaryButtonSmallClass } from "@/lib/ui/form";

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
    return <span className="text-xs text-accent-text">Resolved</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1.5">
        {localStatus === "open" ? (
          <button
            type="button"
            onClick={handleAcknowledge}
            disabled={isPending}
            className={secondaryButtonSmallClass}
          >
            {isPending ? "Acknowledging…" : "Acknowledge"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleResolve}
          disabled={isPending}
          className={secondaryButtonSmallClass}
        >
          {isPending ? "Resolving…" : "Resolve"}
        </button>
      </div>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
