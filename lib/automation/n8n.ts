import type { SchedulingDateContext } from "./scheduling-date-context";
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
    } | null;    /**
     * Customer replies only: today's date/time and the next two weeks of
     * local days in the organization's timezone, so the AI can resolve
     * relative dates ("next Tuesday") into an exact booking date range. See
     * lib/automation/scheduling-date-context.ts.
     */
    scheduling?: SchedulingDateContext;
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

// ---------------------------------------------------------------------------
// P0-B B2.8a: the draft contract for a touch Trackpr claimed and handed to
// n8n (lib/automation/touch-runtime.ts claimAndHandOffTouch /
// resumeClaimedTouch). n8n returns ADVISORY output only. The callback names
// the claimed execution, which Trackpr re-validates against its own rows.
// Everything that decides whether, to whom and when a message is sent stays
// Trackpr's, and the contract has no field for any of it: recipient,
// contact, conversation, send authorization, gate result, lifecycle,
// payment, automation state, retry and scheduling. Any field outside this
// contract is rejected - never ignored into a silent authority. No callback
// uses this yet.
// ---------------------------------------------------------------------------

export type N8nDraftClassification = {
  qualification_status: "new" | "qualifying" | "qualified" | "needs_human" | null;
  urgency: "low" | "normal" | "high" | "emergency" | null;
  intent: string | null;
  summary: string | null;
  missing_information: string[];
};

export type N8nDraftUsage = { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };

export type N8nTouchDraft = {
  /** The drafted message, or null when the AI declines to draft one. Its content is the outbound gate's to judge. */
  body: string | null;
  /** The AI asks for a person: never sent, recorded as blocked. */
  needs_human: boolean;
  classification: N8nDraftClassification | null;
  /** The model that drafted it - required: a draft without one is an AI failure, not a draft. */
  model: string;
  usage: N8nDraftUsage | null;
};

/** "Draft returned for claimed execution". */
export type N8nDraftCallback = {
  execution_id: string;
  event_id: string;
  organization_id: string;
  automation_id: string;
  draft: N8nTouchDraft;
};

const DRAFT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_AUTOMATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DRAFT_BODY_MAX = 1600;
const DRAFT_SHORT_MAX = 200;
const CALLBACK_FIELDS = ["execution_id", "event_id", "organization_id", "automation_id", "draft"] as const;
const DRAFT_FIELDS = ["body", "needs_human", "classification", "model", "usage"] as const;
const CLASSIFICATION_FIELDS = ["qualification_status", "urgency", "intent", "summary", "missing_information"] as const;
const USAGE_FIELDS = ["input_tokens", "output_tokens", "total_tokens"] as const;
const QUALIFICATION = new Set(["new", "qualifying", "qualified", "needs_human"]);
const URGENCY = new Set(["low", "normal", "high", "emergency"]);

type DraftValidation = { ok: true; callback: N8nDraftCallback } | { ok: false; error: string };

function unexpectedField(value: Record<string, unknown>, allowed: readonly string[], at: string): string | null {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra === undefined ? null : `unexpected field: ${at}${extra}`;
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isShortOrNull = (value: unknown, max: number) => value === null || (typeof value === "string" && value.length <= max);
const isCountOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);

/** Strict, dependency-free validation of an untrusted draft callback body: shape only - every id is then checked against Trackpr's own rows. */
export function validateN8nDraftCallback(raw: unknown): DraftValidation {
  if (!isObject(raw)) return { ok: false, error: "body must be a JSON object" };
  const extra = unexpectedField(raw, CALLBACK_FIELDS, "");
  if (extra) return { ok: false, error: extra };
  for (const key of ["execution_id", "event_id", "organization_id"] as const) {
    if (typeof raw[key] !== "string" || !DRAFT_UUID.test(raw[key] as string)) return { ok: false, error: `${key} must be a UUID` };
  }
  if (typeof raw.automation_id !== "string" || raw.automation_id.length > 64 || !DRAFT_AUTOMATION_ID.test(raw.automation_id)) return { ok: false, error: "automation_id must be an automation id" };

  const draft = raw.draft;
  if (!isObject(draft)) return { ok: false, error: "draft must be an object" };
  const draftExtra = unexpectedField(draft, DRAFT_FIELDS, "draft.");
  if (draftExtra) return { ok: false, error: draftExtra };
  if (draft.body !== null && (typeof draft.body !== "string" || draft.body.trim().length === 0 || draft.body.length > DRAFT_BODY_MAX)) return { ok: false, error: "draft.body must be non-empty text within the length limit, or null" };
  if (typeof draft.needs_human !== "boolean") return { ok: false, error: "draft.needs_human must be a boolean" };
  if (typeof draft.model !== "string" || draft.model.trim().length === 0 || draft.model.length > DRAFT_SHORT_MAX) return { ok: false, error: "draft.model must be a short string" };

  let classification: N8nDraftClassification | null = null;
  if (draft.classification !== null && draft.classification !== undefined) {
    const c = draft.classification;
    if (!isObject(c)) return { ok: false, error: "draft.classification must be an object or null" };
    const cExtra = unexpectedField(c, CLASSIFICATION_FIELDS, "draft.classification.");
    if (cExtra) return { ok: false, error: cExtra };
    if (!(c.qualification_status === null || c.qualification_status === undefined || (typeof c.qualification_status === "string" && QUALIFICATION.has(c.qualification_status)))) return { ok: false, error: "draft.classification.qualification_status is not a known status" };
    if (!(c.urgency === null || c.urgency === undefined || (typeof c.urgency === "string" && URGENCY.has(c.urgency)))) return { ok: false, error: "draft.classification.urgency is not a known level" };
    if (!isShortOrNull(c.intent ?? null, DRAFT_SHORT_MAX) || !isShortOrNull(c.summary ?? null, DRAFT_SHORT_MAX * 4)) return { ok: false, error: "draft.classification text fields must be short strings or null" };
    const missing = c.missing_information ?? [];
    if (!Array.isArray(missing) || missing.length > 10 || !missing.every((item) => typeof item === "string" && item.length <= DRAFT_SHORT_MAX)) return { ok: false, error: "draft.classification.missing_information must be a short list of short strings" };
    classification = {
      qualification_status: (c.qualification_status ?? null) as N8nDraftClassification["qualification_status"],
      urgency: (c.urgency ?? null) as N8nDraftClassification["urgency"],
      intent: (c.intent ?? null) as string | null,
      summary: (c.summary ?? null) as string | null,
      missing_information: missing as string[],
    };
  }

  let usage: N8nDraftUsage | null = null;
  if (draft.usage !== null && draft.usage !== undefined) {
    const u = draft.usage;
    if (!isObject(u)) return { ok: false, error: "draft.usage must be an object or null" };
    const uExtra = unexpectedField(u, USAGE_FIELDS, "draft.usage.");
    if (uExtra) return { ok: false, error: uExtra };
    if (!isCountOrNull(u.input_tokens ?? null) || !isCountOrNull(u.output_tokens ?? null) || !isCountOrNull(u.total_tokens ?? null)) return { ok: false, error: "draft.usage token counts must be non-negative integers or null" };
    usage = { input_tokens: (u.input_tokens ?? null) as number | null, output_tokens: (u.output_tokens ?? null) as number | null, total_tokens: (u.total_tokens ?? null) as number | null };
  }

  return {
    ok: true,
    callback: {
      execution_id: raw.execution_id as string,
      event_id: raw.event_id as string,
      organization_id: raw.organization_id as string,
      automation_id: raw.automation_id,
      draft: { body: draft.body as string | null, needs_human: draft.needs_human, classification, model: draft.model, usage },
    },
  };
}

/** The runtime's view of a validated n8n draft (lib/automation/touch-runtime.ts TouchDraft): the body and the needs-human signal - nothing else reaches the send path. */
export function touchDraftFromN8n(draft: N8nTouchDraft): { body: string | null; needsHuman: boolean } {
  return { body: draft.body, needsHuman: draft.needs_human };
}
