import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Final Batch 2: per-source abuse limits for the public lead-capture
 * endpoint (app/api/leads/capture/[token]/route.ts), on top of the existing
 * org-wide new-lead cap in that route.
 *
 * Storage: no new table or service. Every request that passes these limits
 * is recorded as one audit_log row (action lead_capture_request, written
 * with the service role - audit_log has no client INSERT policy), carrying
 * only keyed one-way hashes of the source IP and of the submitted phone
 * number - never the raw IP, phone or token. The limits are counts of those
 * rows in a window.
 *
 * Keys - never a caller-chosen body field alone:
 *   - source: the client IP as set by the hosting platform's edge
 *     (x-vercel-forwarded-for, then x-real-ip, then the first
 *     x-forwarded-for hop; Vercel overwrites these, so a client cannot pick
 *     its own). A request with no usable IP shares one "unknown" bucket -
 *     the conservative choice.
 *   - phone: the submitted phone, normalized - caps how often one number can
 *     be submitted (the abuse that matters: texting a victim's phone).
 *   - organization: every request for this organization, whatever its
 *     source - a backstop against a flood spread over many IPs.
 * Different sources are counted independently: one noisy IP never blocks
 * another (until the organization-wide backstop).
 *
 * Fails CLOSED: if any count or the request record cannot be read/written,
 * or the hashing key is unavailable, the request is refused (503) - an
 * undetermined decision is never treated as "under the limit".
 */

export const LEAD_CAPTURE_REQUEST_ACTION = "lead_capture_request";

export const INTAKE_RATE_LIMITS = {
  /** Requests from one source IP to one organization's intake URL. */
  source: { windowMinutes: 10, max: 10 },
  /** Submissions of one phone number to one organization. */
  phone: { windowMinutes: 60, max: 5 },
  /** All requests to one organization's intake URL, whatever their source. */
  organization: { windowMinutes: 10, max: 60 },
} as const;

export type IntakeRateLimitScope = keyof typeof INTAKE_RATE_LIMITS;

export type IntakeRateDecision =
  | { ok: true }
  | { ok: false; status: 429; scope: IntakeRateLimitScope }
  | { ok: false; status: 503; reason: "rate_limit_unavailable" };

const UNKNOWN_SOURCE = "unknown";

function firstHop(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return isIP(first) ? first : null;
}

/** The platform-supplied client IP, or "unknown" when none is usable. */
export function intakeSourceIp(headers: Headers): string {
  return firstHop(headers.get("x-vercel-forwarded-for")) ?? firstHop(headers.get("x-real-ip")) ?? firstHop(headers.get("x-forwarded-for")) ?? UNKNOWN_SOURCE;
}

/**
 * A keyed, one-way, truncated hash - the audit row must not let anyone who
 * can read it (any member of the organization) recover a visitor's IP or a
 * phone number by brute force. Keyed with the server-only service-role key,
 * which is already required for this route to run; null when it is absent
 * (the caller then fails closed).
 */
export function intakeRateKey(kind: "ip" | "phone", value: string): string | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`trackpr:lead-intake-rate:v1:${kind}:${value}`).digest("hex").slice(0, 32);
}

type CountFilter = { column: string; value: string } | null;

async function countRequests(service: SupabaseClient, organizationId: string, windowMinutes: number, filter: CountFilter, now: Date): Promise<number | null> {
  try {
    let query = service
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("action", LEAD_CAPTURE_REQUEST_ACTION)
      .gte("created_at", new Date(now.getTime() - windowMinutes * 60_000).toISOString());
    if (filter) query = query.eq(filter.column, filter.value);
    const { count, error } = await query;
    if (error || typeof count !== "number") return null;
    return count;
  } catch {
    return null;
  }
}

async function limitExceeded(
  service: SupabaseClient,
  organizationId: string,
  keys: { ipKey: string; phoneKey: string | null },
  now: Date,
  inclusive: boolean,
): Promise<IntakeRateDecision> {
  const checks: { scope: IntakeRateLimitScope; filter: CountFilter }[] = [
    { scope: "source", filter: { column: "metadata->>ip_key", value: keys.ipKey } },
    ...(keys.phoneKey ? [{ scope: "phone" as const, filter: { column: "metadata->>phone_key", value: keys.phoneKey } }] : []),
    { scope: "organization", filter: null },
  ];
  const counts = await Promise.all(checks.map((check) => countRequests(service, organizationId, INTAKE_RATE_LIMITS[check.scope].windowMinutes, check.filter, now)));
  for (let i = 0; i < checks.length; i++) {
    const count = counts[i];
    if (count === null) return { ok: false, status: 503, reason: "rate_limit_unavailable" };
    const max = INTAKE_RATE_LIMITS[checks[i].scope].max;
    // Before recording, this request is not yet counted (at the limit -> refuse);
    // after recording it is (over the limit -> refuse).
    if (inclusive ? count > max : count >= max) return { ok: false, status: 429, scope: checks[i].scope };
  }
  return { ok: true };
}

/**
 * Checks every limit, records this request, then re-checks the same limits
 * including it - so concurrent requests that all passed the first check
 * cannot together exceed a limit (at worst they all refuse). A request
 * refused by the first check records nothing, so a flood does not grow the
 * table.
 */
export async function checkAndRecordIntakeRequest(
  service: SupabaseClient,
  input: { organizationId: string; sourceIp: string; phone: string | null; now?: Date },
): Promise<IntakeRateDecision> {
  const now = input.now ?? new Date();
  const ipKey = intakeRateKey("ip", input.sourceIp);
  const phoneKey = input.phone ? intakeRateKey("phone", input.phone) : null;
  if (!ipKey || (input.phone && !phoneKey)) return { ok: false, status: 503, reason: "rate_limit_unavailable" };
  const keys = { ipKey, phoneKey };

  const before = await limitExceeded(service, input.organizationId, keys, now, false);
  if (!before.ok) return before;

  try {
    const { error } = await service.from("audit_log").insert({
      organization_id: input.organizationId,
      user_id: null,
      action: LEAD_CAPTURE_REQUEST_ACTION,
      entity_type: "lead_capture",
      entity_id: null,
      metadata: phoneKey ? { ip_key: ipKey, phone_key: phoneKey } : { ip_key: ipKey },
    });
    if (error) return { ok: false, status: 503, reason: "rate_limit_unavailable" };
  } catch {
    return { ok: false, status: 503, reason: "rate_limit_unavailable" };
  }

  return limitExceeded(service, input.organizationId, keys, now, true);
}
