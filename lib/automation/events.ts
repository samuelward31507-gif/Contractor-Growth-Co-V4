import type { SupabaseClient } from "@supabase/supabase-js";

export type AutomationEventStatus = "pending" | "processing" | "completed" | "failed";

export type AutomationEvent = {
  id: string;
  organization_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  status: AutomationEventStatus;
  payload: Record<string, unknown>;
  error_message: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export type CreateAutomationEventInput = {
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Deterministic, caller-supplied key that makes this event safe to retry.
   * Never generate this from a timestamp or random value - it must be
   * derivable again from the same business event (e.g.
   * `lead.created:${leadId}`) so a retried request or replayed webhook
   * resolves to the same automation_events row instead of a duplicate.
   */
  idempotencyKey?: string | null;
};

export type CreateAutomationEventResult =
  | { ok: true; event: AutomationEvent; duplicate: boolean }
  | { ok: false; error: string };

/**
 * The only sanctioned way to write an automation_events row.
 * automation_events has no client-facing INSERT policy - RLS only grants
 * SELECT - so this always goes through the `create_automation_event`
 * SECURITY DEFINER RPC, which resolves the organization from auth.uid()
 * itself. This function never accepts or forwards a client-supplied
 * organization id, and never runs as an unauthenticated/public endpoint.
 */
export async function createAutomationEvent(
  supabase: SupabaseClient,
  input: CreateAutomationEventInput,
): Promise<CreateAutomationEventResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not authenticated." };
  }

  const eventType = input.eventType.trim().toLowerCase();
  if (!EVENT_TYPE_PATTERN.test(eventType)) {
    return { ok: false, error: "Invalid event type. Expected a form like lead.created." };
  }

  const entityType = input.entityType?.trim().toLowerCase() || null;
  if (entityType && !ENTITY_TYPE_PATTERN.test(entityType)) {
    return { ok: false, error: "Invalid entity type." };
  }

  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { ok: false, error: "Idempotency key is too long." };
  }

  const { data, error } = await supabase
    .rpc("create_automation_event", {
      p_event_type: eventType,
      p_entity_type: entityType,
      p_entity_id: input.entityId ?? null,
      p_payload: input.payload ?? {},
      p_idempotency_key: idempotencyKey,
    })
    .single();

  if (error || !data) {
    return { ok: false, error: "We couldn't record this automation event." };
  }

  const { is_duplicate, ...event } = data as AutomationEvent & { is_duplicate: boolean };
  return { ok: true, event, duplicate: is_duplicate };
}

/**
 * Service-role variant for callers with no Supabase Auth session - today
 * only the inbound SMS webhook (app/api/webhooks/sms/inbound), which
 * authenticates via Twilio's HMAC signature rather than a user JWT, exactly
 * like the n8n callback route already does for the execution RPCs. The
 * caller must supply organizationId itself, already resolved and trusted
 * (the inbound webhook derives it from organizations.sms_phone_number
 * before ever calling this) - this function never derives it from anything
 * client-supplied. The underlying RPC recognizes the service_role Postgres
 * role as a second legitimate caller (see the
 * automation_rpcs_service_role_access migration); validation and
 * idempotency behavior are otherwise identical to createAutomationEvent.
 */
export async function createAutomationEventAsService(
  supabase: SupabaseClient,
  organizationId: string,
  input: CreateAutomationEventInput,
): Promise<CreateAutomationEventResult> {
  const eventType = input.eventType.trim().toLowerCase();
  if (!EVENT_TYPE_PATTERN.test(eventType)) {
    return { ok: false, error: "Invalid event type. Expected a form like lead.created." };
  }

  const entityType = input.entityType?.trim().toLowerCase() || null;
  if (entityType && !ENTITY_TYPE_PATTERN.test(entityType)) {
    return { ok: false, error: "Invalid entity type." };
  }

  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { ok: false, error: "Idempotency key is too long." };
  }

  const { data, error } = await supabase
    .rpc("create_automation_event", {
      p_event_type: eventType,
      p_entity_type: entityType,
      p_entity_id: input.entityId ?? null,
      p_payload: input.payload ?? {},
      p_idempotency_key: idempotencyKey,
      p_organization_id: organizationId,
    })
    .single();

  if (error || !data) {
    return { ok: false, error: "We couldn't record this automation event." };
  }

  const { is_duplicate, ...event } = data as AutomationEvent & { is_duplicate: boolean };
  return { ok: true, event, duplicate: is_duplicate };
}
