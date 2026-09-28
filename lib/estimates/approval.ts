import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "@/lib/automation/events";
import { emitEstimateLifecycleEventAsService } from "@/lib/automation/estimates";
import { emitJobCreatedFromEstimate } from "@/lib/automation/jobs";

/**
 * Quote Approval Links (V1): the service-side logic behind the public
 * app/quote/[token] page - the customer-facing half of the estimate
 * lifecycle that lib/automation/estimate-reply.ts already handles for the
 * "customer texted an unambiguous yes" case.
 *
 * Trust model: identical to app/api/leads/capture/[token]/route.ts. The
 * caller resolves an unguessable, database-generated token
 * (estimates.approval_token - see its migration) with a service-role
 * client; the token authorizes reading ONE estimate's public summary and a
 * single sent -> accepted/declined transition, nothing else. Every function
 * here takes that already-created service client as an argument (the
 * estimate-reply.ts convention) rather than creating its own.
 *
 * The acceptance sequence deliberately mirrors estimate-reply.ts line for
 * line - guarded transition (status='sent' in the WHERE, so a double-tap or
 * a race with an SMS "yes" can never double-fire), then
 * emitEstimateLifecycleEventAsService, then emitJobCreatedFromEstimate
 * (estimate accepted is the sole job-creation trigger, per Phase 4.6; the
 * same documented service-client limitation applies: the job row and
 * lead->won sync are fully correct, only the optional job-kickoff
 * notification no-ops), then an idempotent automation event recording HOW
 * the acceptance happened (estimate.accepted_via_link vs .._via_reply) so
 * analytics can tell the channels apart. No outbound SMS is sent from this
 * path: unlike the reply path there is no conversation the customer just
 * wrote in, and the on-page confirmation state already tells them it
 * worked.
 */

export type ApprovalDecision = "accept" | "decline";

export type ApprovalOutcome = "accepted" | "declined" | "already_responded" | "expired" | "not_found";

export type PublicEstimate = {
  id: string;
  organizationId: string;
  title: string;
  amount: number | null;
  status: "draft" | "sent" | "accepted" | "declined" | "cancelled" | "expired";
  notes: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  expiresAt: string | null;
  organizationName: string;
  organizationPhone: string | null;
};

const PUBLIC_ESTIMATE_COLUMNS =
  "id, organization_id, title, amount, status, notes, sent_at, responded_at, expires_at, organization:organizations(name, sms_phone_number)";

type RawRow = {
  id: string;
  organization_id: string;
  title: string;
  amount: number | null;
  status: PublicEstimate["status"];
  notes: string | null;
  sent_at: string | null;
  responded_at: string | null;
  expires_at: string | null;
  organization: { name: string; sms_phone_number: string | null } | { name: string; sms_phone_number: string | null }[] | null;
};

function isPastExpiry(estimate: Pick<PublicEstimate, "expiresAt">): boolean {
  return estimate.expiresAt != null && new Date(estimate.expiresAt).getTime() < Date.now();
}

/**
 * Resolves an approval token to the estimate summary the public page shows.
 * Returns null for an unknown token AND for a draft: a draft has never been
 * sent to the customer, so its link must behave as if it does not exist -
 * exposing a draft through a leaked token would show unfinished pricing.
 */
export async function getEstimateByApprovalToken(service: SupabaseClient, token: string): Promise<PublicEstimate | null> {
  if (!token || token.length < 10) return null;

  const { data } = await service
    .from("estimates")
    .select(PUBLIC_ESTIMATE_COLUMNS)
    .eq("approval_token", token)
    .maybeSingle<RawRow>();

  if (!data || data.status === "draft") return null;

  const organization = Array.isArray(data.organization) ? (data.organization[0] ?? null) : data.organization;
  if (!organization) return null;

  return {
    id: data.id,
    organizationId: data.organization_id,
    title: data.title,
    amount: data.amount,
    status: data.status,
    notes: data.notes,
    sentAt: data.sent_at,
    respondedAt: data.responded_at,
    expiresAt: data.expires_at,
    organizationName: organization.name,
    organizationPhone: organization.sms_phone_number,
  };
}

/**
 * Records the first time the customer opened a still-open quote. One
 * timestamp, set once (the WHERE guards both), and deliberately
 * fire-and-forget for the page: a failed view-write must never block
 * rendering the quote itself.
 */
export async function markApprovalViewed(service: SupabaseClient, estimateId: string): Promise<void> {
  const { error } = await service
    .from("estimates")
    .update({ approval_first_viewed_at: new Date().toISOString() })
    .eq("id", estimateId)
    .eq("status", "sent")
    .is("approval_first_viewed_at", null);
  if (error) {
    console.error("[quote-approval] failed to record first view", { estimateId, error });
  }
}

export async function respondToEstimateByToken(
  service: SupabaseClient,
  token: string,
  decision: ApprovalDecision,
): Promise<ApprovalOutcome> {
  const estimate = await getEstimateByApprovalToken(service, token);
  if (!estimate) return "not_found";
  if (estimate.status !== "sent") return "already_responded";
  if (isPastExpiry(estimate)) return "expired";

  const toStatus = decision === "accept" ? "accepted" : "declined";

  // Guarded exactly like estimate-reply.ts: the status='sent' condition in
  // the WHERE makes this a compare-and-swap, so a double-tap, a stale tab,
  // or a race against an SMS acceptance resolves to exactly one winner.
  const { data: transitioned } = await service
    .from("estimates")
    .update({ status: toStatus, responded_at: new Date().toISOString() })
    .eq("id", estimate.id)
    .eq("organization_id", estimate.organizationId)
    .eq("status", "sent")
    .select("id")
    .maybeSingle();

  if (!transitioned) return "already_responded";

  await emitEstimateLifecycleEventAsService(
    service,
    estimate.organizationId,
    estimate.id,
    decision === "accept" ? "estimate.accepted" : "estimate.declined",
  );

  if (decision === "accept") {
    // Same call, same documented service-client limitation as the reply
    // path (see estimate-reply.ts's own comment block above this call).
    await emitJobCreatedFromEstimate(service, estimate.organizationId, estimate.id);
  }

  const eventType = decision === "accept" ? "estimate.accepted_via_link" : "estimate.declined_via_link";
  const eventResult = await createAutomationEventAsService(service, estimate.organizationId, {
    eventType,
    entityType: "estimate",
    entityId: estimate.id,
    payload: { estimate_id: estimate.id, source: "approval_link" },
    idempotencyKey: `${eventType}:${estimate.id}`,
  });
  if (!eventResult.ok) {
    // The state change above already succeeded and is the source of truth -
    // a failed analytics event is logged, never surfaced to the customer.
    console.error("[quote-approval] failed to create automation event", { estimateId: estimate.id, eventType, error: eventResult.error });
  }

  return decision === "accept" ? "accepted" : "declined";
}
