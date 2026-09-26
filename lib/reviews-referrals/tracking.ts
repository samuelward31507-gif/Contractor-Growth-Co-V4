import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyFounder } from "@/lib/notifications/founder";
import { recordAutomationHealthSignal } from "@/lib/automation-health/service";

const MAX_FAILURE_REASON_LENGTH = 300;

function bound(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_FAILURE_REASON_LENGTH ? `${trimmed.slice(0, MAX_FAILURE_REASON_LENGTH - 1)}…` : trimmed;
}

type OutcomeInput = {
  organizationId: string;
  jobId: string;
  contactId: string | null;
  conversationId: string | null;
};

type SentOutcome = { kind: "sent"; messageId: string; workflowExecutionId: string };
type FailedOutcome = { kind: "failed"; workflowExecutionId: string | null; reason: string | null };

/**
 * Writes (or updates) exactly one row in `table` for this job, never more
 * than one - matches the DB's own unique index on job_id, which is the real
 * duplicate-prevention guarantee; this function's own "only write from an
 * absent or 'failed' row" check is a second, application-level layer on top
 * of it; the DB is the case that would 23505 if this ever raced.
 *
 * Deliberately monotonic in the same spirit as the SMS delivery-status
 * tracker: once a request row reaches 'requested' or beyond (responded/
 * completed/declined/converted), this function never touches it again -
 * only a row that doesn't exist yet, or is currently 'failed' (the one
 * genuinely retriable state), can be written here. A customer's real
 * response or a contractor's real decision must never be silently
 * overwritten by a late/duplicate automation callback.
 */
async function upsertRequestOutcome(
  supabase: SupabaseClient,
  table: "review_requests" | "referral_requests",
  input: OutcomeInput,
  outcome: SentOutcome | FailedOutcome,
  extraFields: Record<string, unknown>,
): Promise<void> {
  const { data: existing } = await supabase.from(table).select("id, status").eq("job_id", input.jobId).eq("organization_id", input.organizationId).maybeSingle();

  if (existing && existing.status !== "failed") {
    return;
  }

  const base = {
    organization_id: input.organizationId,
    job_id: input.jobId,
    contact_id: input.contactId,
    conversation_id: input.conversationId,
    ...extraFields,
  };

  // Both branches must produce the exact same key set and field types
  // (never omit a key, never let `status` narrow to a literal union) - a
  // union of two differently-shaped/differently-literal-typed object types
  // is not a single insertable/updatable row shape as far as Supabase's
  // generated types are concerned, and an omitted key here would silently
  // leave a stale value from a previous row untouched on update rather than
  // being explicitly cleared.
  const patch: {
    organization_id: string;
    job_id: string;
    contact_id: string | null;
    conversation_id: string | null;
    message_id: string | null;
    workflow_execution_id: string | null;
    status: string;
    requested_at: string | null;
    failure_reason: string | null;
  } =
    outcome.kind === "sent"
      ? {
          ...base,
          message_id: outcome.messageId,
          workflow_execution_id: outcome.workflowExecutionId,
          status: "requested",
          requested_at: new Date().toISOString(),
          failure_reason: null,
        }
      : {
          ...base,
          message_id: null,
          workflow_execution_id: outcome.workflowExecutionId,
          status: "failed",
          requested_at: null,
          failure_reason: bound(outcome.reason),
        };

  const { error } = existing
    ? await supabase.from(table).update(patch).eq("id", existing.id)
    : await supabase.from(table).insert(patch);

  if (error) {
    // Never thrown - matches emitPostJobFollowup's own "never fail the
    // caller for bookkeeping" contract (the callback route's real job here
    // is recording the send outcome to messages/workflow_executions, which
    // has already succeeded by the time this runs; a failure writing this
    // secondary tracking row must not surface as a 500 to Twilio/n8n).
    console.error("[reviews-referrals] failed to record request outcome", { table, jobId: input.jobId, error: error.message });
  }
}

export type PostJobFollowupOutcome =
  | { kind: "sent"; messageId: string; workflowExecutionId: string }
  | { kind: "blocked"; workflowExecutionId: string; reason: string }
  | { kind: "send_failed"; workflowExecutionId: string; reason: string };

/**
 * The single place the outcome of a job.post_followup send is translated
 * into review_requests/referral_requests state - called from the n8n
 * callback route (app/api/automation/n8n-callback) right after it already
 * knows the real outcome (gate-blocked / provider-failed / actually sent),
 * using the same service-role client that route already has. Never called
 * from anywhere else, and never itself talks to Twilio/n8n/the outbound
 * gate - this is pure bookkeeping on top of a decision Trackpr's existing
 * safety architecture already made.
 *
 * The referral request is always written (the automation always includes a
 * referral ask). The review request is written only when reviewUrl is
 * non-null - a deterministic, Trackpr-known fact (organizations.review_url
 * at the time the event was created, read from the stored automation_events
 * payload, never re-derived from anything the AI drafted) - matching the
 * product rule that a review ask only really happened when there was a
 * review link to send.
 */
export async function recordPostJobFollowupOutcome(
  supabase: SupabaseClient,
  input: OutcomeInput & { reviewUrl: string | null },
  outcome: PostJobFollowupOutcome,
): Promise<void> {
  const requestOutcome: SentOutcome | FailedOutcome =
    outcome.kind === "sent"
      ? { kind: "sent", messageId: outcome.messageId, workflowExecutionId: outcome.workflowExecutionId }
      : { kind: "failed", workflowExecutionId: outcome.workflowExecutionId, reason: outcome.reason };

  const tasks: Promise<void>[] = [upsertRequestOutcome(supabase, "referral_requests", input, requestOutcome, {})];

  if (input.reviewUrl) {
    tasks.push(upsertRequestOutcome(supabase, "review_requests", input, requestOutcome, { review_url: input.reviewUrl }));
  }

  await Promise.all(tasks);
}

/**
 * Deterministic, non-AI response recording: called from the inbound SMS
 * webhook for every normal (non-keyword) inbound message, after the message
 * itself is already persisted. Finds the contact's single most recent
 * 'requested' review_request and/or referral_request (there can be at most
 * one of each per job, and a contact typically has few completed jobs) and
 * marks it 'responded' - it does NOT attempt to classify whether the reply
 * is positive/negative, a real review confirmation, or anything else; that
 * judgment is explicitly out of scope for this function and for AI (see the
 * migration's own documentation of the status model). Never touches a
 * request that isn't currently 'requested' - a request already 'responded'
 * or further along is left alone, so a second reply from the same customer
 * doesn't reset or duplicate anything.
 *
 * Trackpr 2.0, Phase 4C (P2 #4) - documented, intentional tradeoff: this
 * function receives no message body/content at all (by design - see above),
 * so it cannot and does not check whether an inbound reply is topically
 * related to the review/referral ask. A contact who replies about something
 * else entirely (e.g. asking to reschedule an unrelated appointment) while
 * they happen to have a pending 'requested' review/referral will still mark
 * that request 'responded'. This is accepted, not accidental: building real
 * topic classification would mean either a new AI call on every inbound
 * message (out of scope, and this system's own review-escalation logic
 * already runs a conservative keyword heuristic specifically so a
 * genuinely negative reply is never missed - see
 * classifyAndEscalateReviewReply below) or a fragile heuristic that would
 * itself risk missing a real, on-topic response. "Responded" here means
 * "the contact said something back," not "the contact specifically
 * addressed the review/referral ask" - see lib/reviews-referrals/format.ts's
 * own label ("Responded") for the exact, deliberately modest claim this
 * status makes.
 */
export async function recordRequestResponses(supabase: SupabaseClient, organizationId: string, contactId: string): Promise<void> {
  const respondedAt = new Date().toISOString();

  for (const table of ["review_requests", "referral_requests"] as const) {
    const { data } = await supabase
      .from(table)
      .select("id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .eq("status", "requested")
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      await supabase.from(table).update({ status: "responded", responded_at: respondedAt }).eq("id", data.id).eq("status", "requested");
    }
  }
}

// ==================== Growth System Completion Pass 1: Review Escalation ====================

export type ReviewReplySentiment = "positive" | "negative" | "unclear";

/**
 * A small, deterministic, non-AI heuristic - never a model call, never
 * something that could itself compose a reply. Its ONLY job is to decide
 * whether a reply to a review request needs a human's eyes before anything
 * else happens to this conversation; it never argues with the customer,
 * never posts anything publicly, and never makes any reputation decision
 * itself. Deliberately conservative: anything not clearly positive is
 * "unclear" and escalates right alongside "negative" - the cost of a human
 * glancing at an ambiguous reply is far lower than the cost of an unhappy
 * customer's reply going unnoticed.
 */
const NEGATIVE_PATTERNS: RegExp[] = [
  /\bnot happy\b/i,
  /\bnot satisfied\b/i,
  /\bunhappy\b/i,
  /\bdissatisfied\b/i,
  /\bdisappoint(ed|ing)?\b/i,
  /\bterrible\b/i,
  /\bhorrible\b/i,
  /\bawful\b/i,
  /\bworst\b/i,
  /\bbad experience\b/i,
  /\bpoor (service|job|work)\b/i,
  /\brip[\s-]?off\b/i,
  /\bscam\b/i,
  /\bunacceptable\b/i,
  /\bwaste of money\b/i,
  /\brefund\b/i,
  /\bcomplain(t|ing)?\b/i,
  /\bnever again\b/i,
  /\bwould not recommend\b/i,
  /\bwouldn'?t recommend\b/i,
  /\b1 star\b|\bone star\b/i,
  /\b2 star\b|\btwo star\b/i,
];

const POSITIVE_PATTERNS: RegExp[] = [
  /\bgreat\b/i,
  /\bawesome\b/i,
  /\bamazing\b/i,
  /\bexcellent\b/i,
  /\bperfect\b/i,
  /\blove(d)? it\b/i,
  /\bhappy\b/i,
  /\bsatisfied\b/i,
  /\bthank(s| you)\b/i,
  /\bwill do\b/i,
  /\bsure,? (i'?ll|i will)\b/i,
  /\b5 star\b|\bfive star\b/i,
  /\bsounds good\b/i,
  /^\s*(yes|yep|yeah|ok|okay|sure)[.!\s]*$/i,
];

export function classifyReviewReplySentiment(body: string): ReviewReplySentiment {
  const text = body.trim();
  if (!text) return "unclear";
  if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return "negative";
  if (POSITIVE_PATTERNS.some((pattern) => pattern.test(text))) return "positive";
  return "unclear";
}

/**
 * Called from the inbound SMS webhook, BEFORE emitCustomerReplyFollowup, so
 * that a negative/unclear reply to a review request locks AI out of this
 * conversation (the exact same durable conversations.ai_enabled mechanism
 * n8n-callback's own needs_human handling already uses) before the AI
 * automation is ever dispatched - satisfying "do not automatically argue
 * with customers" by construction, not by convention. A clearly positive
 * reply changes nothing here; recordRequestResponses' own deterministic
 * status bookkeeping (unchanged) still runs for every reply regardless of
 * sentiment.
 *
 * Idempotent: the ai_enabled UPDATE below only affects a row that is
 * currently true (`.eq("ai_enabled", true)`), so a second negative reply to
 * an already-escalated conversation is a safe no-op, and notifyFounder is
 * only called when this call is the one that actually performed the lock.
 */
export async function classifyAndEscalateReviewReply(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  conversationId: string,
  messageBody: string,
): Promise<void> {
  const { data: activeReviewRequest } = await supabase
    .from("review_requests")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "requested")
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!activeReviewRequest) return;

  const sentiment = classifyReviewReplySentiment(messageBody);
  if (sentiment === "positive") return;

  const { data: lockedRow, error: lockError } = await supabase
    .from("conversations")
    .update({ ai_enabled: false })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .eq("ai_enabled", true)
    .select("id")
    .maybeSingle();

  if (lockError) {
    console.error("[reviews-referrals] failed to lock conversation after a negative/unclear review reply", { organizationId, conversationId, error: lockError.message });
    return;
  }

  if (lockedRow) {
    // AI-01 (product completion audit): brings this escalation into parity
    // with HANDOFF-01 - every other lockout site in this codebase pairs its
    // notifyFounder call with a durable, dashboard-visible, resolvable
    // automation_incidents row; this one previously didn't. Same category,
    // same fingerprint-per-conversation dedup (a second non-positive reply
    // to an already-escalated conversation is a safe no-op here too, since
    // the ai_enabled guard above already made lockedRow null on replay).
    await recordAutomationHealthSignal(supabase, {
      organizationId,
      category: "human_escalation_requested",
      severity: "warning",
      fingerprintContext: conversationId,
      title: "AI escalated a conversation to a human",
      description: sentiment === "negative" ? "A customer replied negatively to a review request." : "A customer's reply to a review request needs a human look.",
      metadata: { conversationId, contactId },
    });
    await notifyFounder(supabase, {
      organizationId,
      kind: "ai_escalation",
      summary: sentiment === "negative" ? "A customer replied negatively to a review request." : "A customer's reply to a review request needs a human look.",
      detailPath: `/conversations/${conversationId}`,
    });
  }
}
