import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "@/lib/automation/executions";
import { sendOutboundMessage } from "@/lib/messaging/outbound";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 1600;
const MAX_SHORT_FIELD_LENGTH = 200;

type AiResult = {
  should_send: boolean;
  message: string | null;
  intent: string | null;
  summary: string | null;
  needs_human: boolean;
  model: string | null;
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
    if (!isOptionalString(raw2.message, MAX_MESSAGE_LENGTH)) {
      return { ok: false, error: "ai_result.message must be a string within the length limit, or null." };
    }
    if (!isOptionalString(raw2.intent, MAX_SHORT_FIELD_LENGTH)) {
      return { ok: false, error: "ai_result.intent must be a short string or null." };
    }
    if (!isOptionalString(raw2.summary, MAX_SHORT_FIELD_LENGTH * 4)) {
      return { ok: false, error: "ai_result.summary must be a string within the length limit, or null." };
    }
    if (!isOptionalString(raw2.model, MAX_SHORT_FIELD_LENGTH)) {
      return { ok: false, error: "ai_result.model must be a short string or null." };
    }
    if (raw2.should_send && !raw2.message) {
      return { ok: false, error: "ai_result.message is required when should_send is true." };
    }

    aiResult = {
      should_send: raw2.should_send,
      message: (raw2.message as string | null) ?? null,
      intent: (raw2.intent as string | null) ?? null,
      summary: (raw2.summary as string | null) ?? null,
      needs_human: raw2.needs_human,
      model: (raw2.model as string | null) ?? null,
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

  if (aiResult) {
    const leadId = event.entity_type === "lead" ? event.entity_id : null;
    const contactId =
      typeof event.payload?.contact_id === "string" ? (event.payload.contact_id as string) : null;

    const { error: aiInsertError } = await service.from("ai_interactions").insert({
      organization_id: event.organization_id,
      lead_id: leadId,
      contact_id: contactId,
      interaction_type: "lead_followup_response",
      input: { event_type: event.event_type, entity_type: event.entity_type, entity_id: event.entity_id, payload: event.payload },
      output: aiResult,
      model: aiResult.model,
    });

    if (aiInsertError) {
      console.error("[automation] failed to record ai_interaction", { executionId: execution.id, error: aiInsertError.message });
    }
  }

  if (!aiResult || !aiResult.should_send) {
    const result = await completeWorkflowExecutionAsService(service, execution.id, {
      should_send: false,
      needs_human: aiResult?.needs_human ?? null,
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

  const contactId =
    typeof event.payload?.contact_id === "string" ? (event.payload.contact_id as string) : null;

  if (!contactId) {
    const failed = await failWorkflowExecutionAsService(
      service,
      execution.id,
      "The automation event has no associated contact - SMS could not be attempted.",
    );
    if (!failed.ok && !isAlreadyProcessedError(failed.error)) {
      console.error("[automation] failed to record execution failure", { executionId: execution.id, error: failed.error });
    }
    return NextResponse.json({ ok: true });
  }

  const leadId = event.entity_type === "lead" ? event.entity_id : null;

  // sendOutboundMessage is the single path every outbound SMS goes through:
  // it opens/reuses the conversation, writes the messages row first
  // (status: queued), then calls the SMS provider boundary and updates that
  // same row to sent/failed. sendSms() is still an unconfigured stub, so
  // this always resolves to a failed send today - but the message row and
  // conversation now exist and are fully traceable back to this workflow
  // execution, closing the gap the previous version of this route left open.
  const sendResult = await sendOutboundMessage(service, {
    organizationId: event.organization_id,
    contactId,
    channel: "sms",
    body: aiResult.message ?? "",
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
