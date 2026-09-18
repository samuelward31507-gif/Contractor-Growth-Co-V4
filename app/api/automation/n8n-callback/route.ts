import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "@/lib/automation/executions";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { evaluateOutboundGate } from "@/lib/automation/outbound-gate";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 1600;
const MAX_SHORT_FIELD_LENGTH = 200;
const MAX_MISSING_INFO_ITEMS = 10;

const QUALIFICATION_STATUSES = new Set(["new", "qualifying", "qualified", "needs_human"]);
const URGENCY_LEVELS = new Set(["low", "normal", "high", "emergency"]);

type QualificationStatus = "new" | "qualifying" | "qualified" | "needs_human";
type Urgency = "low" | "normal" | "high" | "emergency";

type AiResult = {
  should_send: boolean;
  response_message: string | null;
  qualification_status: QualificationStatus;
  missing_information: string[];
  urgency: Urgency;
  needs_human: boolean;
  model: string | null;
  // Optional: present for customer.message.received (Phase 4.2), absent for
  // lead.created - both are valid, existing behavior is unchanged either way.
  intent: string | null;
  summary: string | null;
};

type CallbackBody = {
  execution_id: string;
  event_id: string;
  organization_id: string;
  ai_result: AiResult | null;
};

type ValidationResult = { ok: true; body: CallbackBody } | { ok: false; error: string };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isOptionalString(value: unknown, maxLength: number): value is string | null {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.length <= maxLength;
}

/**
 * Manual, dependency-free validation of the untrusted n8n callback body.
 * Nothing here is used for authorization - organization_id is only ever
 * cross-checked against the database-derived value below, never trusted on
 * its own - this only guards the shape of what downstream code (AI output
 * handling, ai_interactions, sendSms) is allowed to see.
 */
function validateBody(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const body = raw as Record<string, unknown>;

  if (!isUuid(body.execution_id)) return { ok: false, error: "execution_id must be a UUID." };
  if (!isUuid(body.event_id)) return { ok: false, error: "event_id must be a UUID." };
  if (!isUuid(body.organization_id)) return { ok: false, error: "organization_id must be a UUID." };

  let aiResult: AiResult | null = null;
  if (body.ai_result !== null && body.ai_result !== undefined) {
    if (typeof body.ai_result !== "object") {
      return { ok: false, error: "ai_result must be an object or null." };
    }
    const raw2 = body.ai_result as Record<string, unknown>;

    if (typeof raw2.should_send !== "boolean") {
      return { ok: false, error: "ai_result.should_send must be a boolean." };
    }
    if (typeof raw2.needs_human !== "boolean") {
      return { ok: false, error: "ai_result.needs_human must be a boolean." };
    }
    if (!isOptionalString(raw2.response_message, MAX_MESSAGE_LENGTH)) {
      return { ok: false, error: "ai_result.response_message must be a string within the length limit, or null." };
    }
    if (typeof raw2.qualification_status !== "string" || !QUALIFICATION_STATUSES.has(raw2.qualification_status)) {
      return { ok: false, error: "ai_result.qualification_status must be one of new, qualifying, qualified, needs_human." };
    }
    if (
      !Array.isArray(raw2.missing_information) ||
      raw2.missing_information.length > MAX_MISSING_INFO_ITEMS ||
      !raw2.missing_information.every((item) => typeof item === "string" && item.length <= MAX_SHORT_FIELD_LENGTH)
    ) {
      return { ok: false, error: "ai_result.missing_information must be an array of short strings." };
    }
    if (typeof raw2.urgency !== "string" || !URGENCY_LEVELS.has(raw2.urgency)) {
      return { ok: false, error: "ai_result.urgency must be one of low, normal, high, emergency." };
    }
    if (!isOptionalString(raw2.model, MAX_SHORT_FIELD_LENGTH)) {
      return { ok: false, error: "ai_result.model must be a short string or null." };
    }
    if (!isOptionalString(raw2.intent, MAX_SHORT_FIELD_LENGTH)) {
      return { ok: false, error: "ai_result.intent must be a short string or null." };
    }
    if (!isOptionalString(raw2.summary, MAX_SHORT_FIELD_LENGTH * 4)) {
      return { ok: false, error: "ai_result.summary must be a string within the length limit, or null." };
    }
    if (raw2.should_send && !raw2.response_message) {
      return { ok: false, error: "ai_result.response_message is required when should_send is true." };
    }

    aiResult = {
      should_send: raw2.should_send,
      response_message: (raw2.response_message as string | null) ?? null,
      qualification_status: raw2.qualification_status as QualificationStatus,
      missing_information: raw2.missing_information as string[],
      urgency: raw2.urgency as Urgency,
      needs_human: raw2.needs_human,
      model: (raw2.model as string | null) ?? null,
      intent: (raw2.intent as string | null) ?? null,
      summary: (raw2.summary as string | null) ?? null,
    };
  }

  return {
    ok: true,
    body: {
      execution_id: body.execution_id as string,
      event_id: body.event_id as string,
      organization_id: body.organization_id as string,
      ai_result: aiResult,
    },
  };
}

function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.N8N_WEBHOOK_SECRET;
  // No secret configured means no request can ever be trusted - reject
  // everything rather than accepting unauthenticated callbacks.
  if (!configuredSecret) return false;

  const provided = request.headers.get("x-trackpr-webhook-secret");
  if (!provided) return false;

  const expected = Buffer.from(configuredSecret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

type EmbeddedEvent = {
  id: string;
  organization_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
};

function normalizeEvent(value: EmbeddedEvent | EmbeddedEvent[] | null): EmbeddedEvent | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * The RPCs' own UPDATE ... WHERE status = 'running' is the actual source of
 * truth for "did this call win the race" - the earlier status check in this
 * route is only a fast path to skip unnecessary work for an obviously
 * already-processed execution. If two callbacks for the same execution
 * genuinely race, the loser lands here: that's an expected, benign outcome
 * (someone else already recorded the result), not a server error.
 */
function isAlreadyProcessedError(error: string): boolean {
  return error === "Execution is not running";
}

/**
 * Maps an automation event_type to the ai_interactions.interaction_type
 * label it should be recorded under. interaction_type has no CHECK
 * constraint (free text), so adding a new event type here never needs a
 * migration - only this mapping.
 */
function interactionTypeFor(eventType: string): string {
  switch (eventType) {
    case "customer.message.received":
      return "customer_reply_response";
    case "appointment.created":
      return "appointment_created_response";
    case "appointment.no_show":
      return "appointment_no_show_response";
    case "estimate.sent":
      return "estimate_sent_response";
    default:
      return "lead_followup_response";
  }
}

/**
 * Phase 4.4: appointment-context sends (confirmation, no-show follow-up)
 * are only allowed while the appointment is still in the specific state
 * that message type makes sense for - re-checked live by the gate, never
 * trusted from when the automation event was originally created.
 */
function appointmentEligibleStatusesFor(eventType: string): ("scheduled" | "confirmed" | "completed" | "cancelled" | "no_show")[] | null {
  if (eventType === "appointment.created") return ["scheduled", "confirmed"];
  if (eventType === "appointment.no_show") return ["no_show"];
  return null;
}

/**
 * Phase 4.5: same pattern as appointmentEligibleStatusesFor, for
 * estimate.sent's initial notification - only sendable while the estimate
 * is still 'sent' (not yet accepted/declined/cancelled/expired).
 */
function estimateEligibleStatusesFor(eventType: string): ("draft" | "sent" | "accepted" | "declined" | "cancelled" | "expired")[] | null {
  if (eventType === "estimate.sent") return ["sent"];
  return null;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const validation = validateBody(raw);
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
  }
  const body = validation.body;

  const service = createServiceRoleClient();

  const { data: execution, error: lookupError } = await service
    .from("workflow_executions")
    .select(
      "id, status, workflow_name, automation_event_id, organization_id, automation_events(id, organization_id, event_type, entity_type, entity_id, payload)",
    )
    .eq("id", body.execution_id)
    .maybeSingle();

  if (lookupError || !execution) {
    return NextResponse.json({ ok: false, error: "Execution not found." }, { status: 404 });
  }

  const event = normalizeEvent(
    execution.automation_events as EmbeddedEvent | EmbeddedEvent[] | null,
  );

  if (!event) {
    return NextResponse.json({ ok: false, error: "Execution not found." }, { status: 404 });
  }

  // Never trust organization_id/event_id from the request body for
  // authorization - only use them as a consistency check against the
  // relationships actually stored in the database.
  if (execution.automation_event_id !== body.event_id) {
    return NextResponse.json({ ok: false, error: "Execution does not belong to the referenced event." }, { status: 400 });
  }
  if (event.organization_id !== body.organization_id || execution.organization_id !== event.organization_id) {
    return NextResponse.json({ ok: false, error: "Organization mismatch." }, { status: 403 });
  }

  if (execution.status !== "running") {
    // Replayed/duplicate callback for an execution that's already been
    // completed or failed - a clean, idempotent no-op rather than an error
    // or a second mutation.
    return NextResponse.json({ ok: true, alreadyProcessed: true });
  }

  const aiResult = body.ai_result;

  // entity_id/entity_type covers lead.created (entity_type: "lead").
  // customer.message.received's entity is the conversation, with lead_id
  // (possibly null - not every conversation has an associated lead) carried
  // in the payload instead.
  const leadId =
    event.entity_type === "lead"
      ? event.entity_id
      : typeof event.payload?.lead_id === "string"
        ? (event.payload.lead_id as string)
        : null;

  // Phase 4.3: should_send is no longer forced false for
  // customer.message.received - the AI may now recommend sending, but that
  // recommendation only ever reaches sendOutboundMessage() after passing
  // the safe outbound gate below. lead.created's should_send remains
  // hardcoded false in n8n itself (that branch is intentionally unchanged
  // this phase), so it never reaches the gate in practice, but the gate
  // path is fully generic and would apply to it the same way if that ever
  // changed.
  const contactId =
    typeof event.payload?.contact_id === "string" ? (event.payload.contact_id as string) : null;
  const conversationId =
    typeof event.payload?.conversation_id === "string" ? (event.payload.conversation_id as string) : null;

  if (aiResult) {
    const interactionType = interactionTypeFor(event.event_type);

    // Upsert on workflow_execution_id (unique, nullable-safe) rather than a
    // plain insert: two genuinely concurrent callback deliveries for the
    // same execution could otherwise both pass the running-status check
    // above before either finishes and each write their own AI interaction.
    // ignoreDuplicates makes the loser a no-op instead of a duplicate row.
    const { error: aiInsertError } = await service.from("ai_interactions").upsert(
      {
        organization_id: event.organization_id,
        lead_id: leadId,
        contact_id: contactId,
        conversation_id: conversationId,
        workflow_execution_id: execution.id,
        interaction_type: interactionType,
        input: { event_type: event.event_type, entity_type: event.entity_type, entity_id: event.entity_id, payload: event.payload },
        output: aiResult,
        model: aiResult.model,
      },
      { onConflict: "workflow_execution_id", ignoreDuplicates: true },
    );

    if (aiInsertError) {
      console.error("[automation] failed to record ai_interaction", { executionId: execution.id, error: aiInsertError.message });
    }

    // leads.ai_summary already exists for exactly this purpose - a short,
    // human-readable AI rollup on the lead itself, queryable without
    // parsing ai_interactions.output. ai_score is deliberately left
    // untouched: qualification_status/urgency are categorical, not a score,
    // and inventing a numeric mapping would be exactly the "elaborate
    // scoring system" this phase avoids.
    if (leadId) {
      const summaryParts = [
        `Qualification: ${aiResult.qualification_status}`,
        `Urgency: ${aiResult.urgency}`,
      ];
      if (aiResult.missing_information.length > 0) {
        summaryParts.push(`Missing: ${aiResult.missing_information.join(", ")}`);
      }
      if (aiResult.needs_human) {
        summaryParts.push("Needs human follow-up");
      }
      if (aiResult.summary) {
        summaryParts.push(aiResult.summary);
      }

      const { error: leadUpdateError } = await service
        .from("leads")
        .update({ ai_summary: summaryParts.join(" · ") })
        .eq("id", leadId)
        .eq("organization_id", event.organization_id);

      if (leadUpdateError) {
        console.error("[automation] failed to update lead ai_summary", { executionId: execution.id, error: leadUpdateError.message });
      }
    }
  }

  if (!aiResult || !aiResult.should_send) {
    const result = await completeWorkflowExecutionAsService(service, execution.id, {
      should_send: false,
      needs_human: aiResult?.needs_human ?? null,
      qualification_status: aiResult?.qualification_status ?? null,
      urgency: aiResult?.urgency ?? null,
      missing_information: aiResult?.missing_information ?? null,
      intent: aiResult?.intent ?? null,
      summary: aiResult?.summary ?? null,
    });
    if (!result.ok) {
      if (isAlreadyProcessedError(result.error)) {
        return NextResponse.json({ ok: true, alreadyProcessed: true });
      }
      console.error("[automation] failed to complete execution", { executionId: execution.id, error: result.error });
      return NextResponse.json({ ok: false, error: "Could not record the automation result." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  const appointmentId =
    event.entity_type === "appointment"
      ? event.entity_id
      : typeof event.payload?.appointment_id === "string"
        ? (event.payload.appointment_id as string)
        : null;
  const appointmentEligibleStatuses = appointmentEligibleStatusesFor(event.event_type);

  const estimateId =
    event.entity_type === "estimate"
      ? event.entity_id
      : typeof event.payload?.estimate_id === "string"
        ? (event.payload.estimate_id as string)
        : null;
  const estimateEligibleStatuses = estimateEligibleStatusesFor(event.event_type);

  // Trackpr is the final send authority: the AI/n8n may recommend sending,
  // but nothing reaches the customer without independently passing this
  // gate. Every condition it checks is re-derived from the database, not
  // trusted from this request's payload - see lib/automation/outbound-gate.
  const gateResult = await evaluateOutboundGate(service, {
    organizationId: event.organization_id,
    executionId: execution.id,
    contactId,
    conversationId,
    leadId,
    aiResult: {
      should_send: aiResult.should_send,
      response_message: aiResult.response_message,
      needs_human: aiResult.needs_human,
    },
    appointmentId: appointmentEligibleStatuses ? appointmentId : null,
    appointmentEligibleStatuses: appointmentEligibleStatuses ?? undefined,
    estimateId: estimateEligibleStatuses ? estimateId : null,
    estimateEligibleStatuses: estimateEligibleStatuses ?? undefined,
  });

  if (!gateResult.allowed) {
    // Blocked by Trackpr's own safety decision - not an error. Recorded as
    // a normal completion with should_send:false, exactly like the AI
    // itself returning should_send:false, plus the specific reason so it's
    // inspectable later (metadata is never surfaced to the customer).
    const result = await completeWorkflowExecutionAsService(service, execution.id, {
      should_send: false,
      blocked_reason: gateResult.reason,
      blocked_detail: gateResult.detail ?? null,
      needs_human: aiResult.needs_human,
      qualification_status: aiResult.qualification_status,
      urgency: aiResult.urgency,
      missing_information: aiResult.missing_information,
      intent: aiResult.intent,
      summary: aiResult.summary,
    });
    if (!result.ok) {
      if (isAlreadyProcessedError(result.error)) {
        return NextResponse.json({ ok: true, alreadyProcessed: true });
      }
      console.error("[automation] failed to complete execution", { executionId: execution.id, error: result.error });
      return NextResponse.json({ ok: false, error: "Could not record the automation result." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sent: false, blockedReason: gateResult.reason });
  }

  // sendOutboundMessage is the single path every outbound SMS goes through:
  // it opens/reuses the conversation, writes the messages row first
  // (status: queued), then calls the Twilio provider and updates that same
  // row to sent/failed.
  const sendResult = await sendOutboundMessage(service, {
    organizationId: event.organization_id,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: execution.id,
  });

  if (!sendResult.ok) {
    // The execution must clearly reflect that delivery could not complete;
    // it must never be marked completed as if the customer-facing message
    // went out.
    const failed = await failWorkflowExecutionAsService(service, execution.id, sendResult.error);
    if (!failed.ok && !isAlreadyProcessedError(failed.error)) {
      console.error("[automation] failed to record execution failure", { executionId: execution.id, error: failed.error });
    }
    return NextResponse.json({ ok: true });
  }

  const completed = await completeWorkflowExecutionAsService(service, execution.id, {
    should_send: true,
    message_id: sendResult.messageId,
    conversation_id: sendResult.conversationId,
    provider_message_id: sendResult.providerMessageId,
    lead_id: leadId,
  });
  if (!completed.ok) {
    if (isAlreadyProcessedError(completed.error)) {
      return NextResponse.json({ ok: true, alreadyProcessed: true });
    }
    console.error("[automation] failed to complete execution", { executionId: execution.id, error: completed.error });
    return NextResponse.json({ ok: false, error: "Could not record the automation result." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
