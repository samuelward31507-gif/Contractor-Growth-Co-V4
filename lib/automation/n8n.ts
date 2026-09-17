const N8N_TIMEOUT_MS = 10_000;

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
