import type { OrganizationVertical } from "@/lib/auth/organization";

/**
 * Trackpr 2.0, n8n dispatch timeout fix: n8n's workflows are configured to
 * respond synchronously via a "Respond to Webhook" node - the fetch below
 * doesn't resolve until n8n has already called Claude and finished
 * processing, not merely "accepted" the request. A real production
 * lead_created_followup round trip was directly observed taking ~12.6s
 * (webhook receipt + a real Claude call + n8n's own orchestration
 * overhead), comfortably past the old 10s value - which made a completely
 * successful dispatch get recorded as a failed one purely because Trackpr's
 * own client-side wait gave up first (see failWorkflowExecution's own
 * comment in ./executions for the other half of this fix). 30s is a
 * generous, still-finite multiple of that observed real latency - long
 * enough that a legitimately-slower-but-working call is never mistaken for
 * a hung orchestrator, while still firmly bounding how long Trackpr will
 * ever wait on one. Exported so tests can reference the real production
 * value instead of duplicating a magic number that could silently drift.
 */
export const N8N_TIMEOUT_MS = 30_000;

export type N8nWorkflowContract = {
  version: 1;
  event: {
    id: string;
    type: string;
    organization_id: string;
    entity_type: string | null;
    entity_id: string | null;
    payload: Record<string, unknown>;
  };
  execution: {
    id: string;
    workflow_name: string;
    attempt: number;
  };
  context: {
    organization: {
      id: string;
      name: string;
      timezone: string;
      /**
       * Gym Phase 2B.1: lets n8n branch its prompt/qualification behavior
       * by vertical - "contractor" or "gym", never anything else (fails
       * closed to "contractor" at every call site that populates it,
       * matching lib/auth/organization.ts's own resolveOrganization()
       * convention). Optional, not required: this phase only wires it into
       * lead-followup.ts and customer-reply.ts (the lead-response/
       * qualification dispatches this slice's scope covers) - every other
       * N8nWorkflowContract construction site (appointments.ts, estimates.ts,
       * jobs.ts, lead-nurture.ts, lead-reactivation.ts, n8n-retry.ts,
       * post-job-followup.ts) is untouched and correctly omits it, since
       * changing those files is outside this slice's authorized scope.
       */
      vertical?: OrganizationVertical;
    };
    ai: {
      enabled: boolean;
      tone: string | null;
      business_introduction: string | null;
      general_instructions: string | null;
    };
    contact: {
      id: string;
      first_name: string | null;
      last_name: string | null;
      phone: string | null;
      email: string | null;
    } | null;
  };
};

export type N8nDispatchResult = { ok: true } | { ok: false; error: string; unconfigured?: boolean };

/**
 * Outbound orchestration boundary: the only place this codebase calls out to
 * n8n. `N8N_BASE_URL`/`N8N_WEBHOOK_SECRET` are server-only env vars (never
 * NEXT_PUBLIC_*, never sent to the browser). If either is unset, this
 * returns a typed "unconfigured" failure without attempting a network call -
 * it never pretends a dispatch happened. The secret is sent as a header so
 * n8n's workflow can verify the request genuinely came from Trackpr; it is
 * never logged or included in any error message.
 */
export async function triggerN8nWorkflow(contract: N8nWorkflowContract): Promise<N8nDispatchResult> {
  const baseUrl = process.env.N8N_BASE_URL;
  const secret = process.env.N8N_WEBHOOK_SECRET;

  if (!baseUrl || !secret) {
    return { ok: false, error: "The automation orchestrator is not configured.", unconfigured: true };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/webhook/${contract.execution.workflow_name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trackpr-webhook-secret": secret,
      },
      body: JSON.stringify(contract),
      signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the automation orchestrator." };
  }

  if (!response.ok) {
    return { ok: false, error: `The automation orchestrator rejected the request (status ${response.status}).` };
  }

  return { ok: true };
}
