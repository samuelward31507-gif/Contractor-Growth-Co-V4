import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { resolveOrCreateContact } from "@/lib/contacts/resolve";
import { emitLeadCreatedFollowupAsService } from "@/lib/automation/lead-followup";
import { emitLeadStageChangedAsService } from "@/lib/automation/lead-stage-history";

const MAX_SHORT_FIELD_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 2000;
/** How recently an existing lead for the same contact must have been created to be treated as a duplicate submission (a retried webhook or a double form-submit), not a genuinely new opportunity. */
const DUPLICATE_WINDOW_MINUTES = 10;

/**
 * Trackpr 2.0, Phase 4C (P2 #8): lightweight abuse control for a leaked or
 * guessed lead_intake_token - deliberately org-wide (not per-contact; the
 * existing DUPLICATE_WINDOW_MINUTES check above already handles the
 * per-contact case), and deliberately counting EVERY lead created for this
 * organization in the window regardless of source, never a caller-supplied
 * field (an attacker varying `source` per request must not be able to dodge
 * a per-source count). 20 new leads in 10 minutes is far beyond any real
 * contractor's normal volume through this one endpoint, so this is set
 * generously to avoid ever blocking legitimate traffic - the goal is to stop
 * an obvious flood, not to meter ordinary usage. Uses only the leads table
 * this route already queries for its own duplicate check - no new table, no
 * schema change, no Redis/external service.
 */
const RATE_LIMIT_WINDOW_MINUTES = 10;
const RATE_LIMIT_MAX_LEADS_PER_WINDOW = 20;

/**
 * First-Client Lead Capture V1: the missing connection between an external
 * lead source (a contractor's own website contact form, a lead-gen
 * platform's webhook, Zapier/Make, etc.) and Trackpr. Before this route,
 * every lead required a staff member to have already manually created a
 * contact in the CRM UI, or an inbound SMS reply - there was no automated
 * lead-capture path at all (a real gap this repo's own pre-launch audit
 * found). This is the simplest production-safe intake mechanism that
 * reuses the existing architecture end-to-end rather than inventing new
 * infrastructure: contact dedup (resolveOrCreateContact), the lead.created
 * automation event (emitLeadCreatedFollowupAsService, mirroring
 * emitLeadCreatedFollowup's session-based original), and the existing
 * outbound safety gate/test-live mode downstream of it - none of those are
 * touched by this file.
 *
 * Organization scope: resolved exclusively by looking up the :token path
 * segment against organizations.lead_intake_token (a unique, random,
 * per-organization value - see its own migration) - the exact same pattern
 * organizations.sms_phone_number already uses for the inbound SMS webhook.
 * A client-supplied organization_id in the request body, if present, is
 * never read for authorization anywhere in this file.
 *
 * What this route does NOT do: no lead-source management UI, no
 * configurable field mapping - the minimum needed for the first real
 * contractor to receive a lead safely. Trackpr 2.0, Phase 4C (P2 #8) added a
 * simple, org-wide, database-backed rate limit (see
 * RATE_LIMIT_MAX_LEADS_PER_WINDOW below) - this is deliberately a coarse
 * flood guard, not a precise per-source/per-IP throttle, and never blocks on
 * its own query failing (fails open).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 10) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const service = createServiceRoleClient();

  const { data: organization } = await service
    .from("organizations")
    .select("id")
    .eq("lead_intake_token", token)
    .maybeSingle();

  if (!organization) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const organizationId = organization.id as string;

  // Trackpr 2.0, Phase 4C (P2 #8): checked before any body parsing or
  // contact/lead creation, so a flood never gets far enough to create
  // contacts even when the submissions themselves would otherwise be
  // rejected downstream. Fails OPEN (never blocks) on a query error - for a
  // public lead-capture endpoint, silently under-enforcing an abuse control
  // during a transient database hiccup is far safer than dropping a real
  // contractor's real lead because a rate-limit check itself broke.
  const rateLimitWindowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count: recentLeadCount, error: rateLimitCheckError } = await service
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .gte("created_at", rateLimitWindowStart);

  if (rateLimitCheckError) {
    console.error("[lead-capture] rate-limit check failed - failing open", { organizationId, error: rateLimitCheckError.message });
  } else if ((recentLeadCount ?? 0) >= RATE_LIMIT_MAX_LEADS_PER_WINDOW) {
    console.error("[lead-capture] rate limit exceeded", { organizationId, recentLeadCount });
    return NextResponse.json({ ok: false, error: "Too many submissions. Please try again shortly." }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof raw !== "object" || raw === null) {
    return NextResponse.json({ ok: false, error: "Request body must be a JSON object." }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  function shortString(value: unknown, maxLength: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
  }

  let firstName = shortString(body.first_name, MAX_SHORT_FIELD_LENGTH);
  let lastName = shortString(body.last_name, MAX_SHORT_FIELD_LENGTH);
  if (!firstName && !lastName) {
    // Many external form builders only ever send a single combined "name"
    // field - split on the first space rather than forcing every possible
    // caller to send first_name/last_name separately.
    const name = shortString(body.name, MAX_SHORT_FIELD_LENGTH);
    if (name) {
      const spaceIndex = name.indexOf(" ");
      if (spaceIndex === -1) {
        firstName = name;
      } else {
        firstName = name.slice(0, spaceIndex).trim() || null;
        lastName = name.slice(spaceIndex + 1).trim() || null;
      }
    }
  }

  const phone = shortString(body.phone, MAX_SHORT_FIELD_LENGTH);
  const email = shortString(body.email, MAX_SHORT_FIELD_LENGTH);
  const serviceField = shortString(body.service, MAX_SHORT_FIELD_LENGTH);
  const source = shortString(body.source, MAX_SHORT_FIELD_LENGTH);
  const message = shortString(body.message ?? body.notes, MAX_MESSAGE_LENGTH);

  if (!phone && !email) {
    return NextResponse.json({ ok: false, error: "At least one of phone or email is required." }, { status: 400 });
  }

  const contactResult = await resolveOrCreateContact(service, {
    organizationId,
    firstName,
    lastName,
    phone,
    email,
    notes: message,
  });

  if (contactResult.outcome === "conflict") {
    console.error("[lead-capture] phone/email matched two different contacts", { organizationId });
    return NextResponse.json(
      { ok: false, error: "This phone number and email are already on file for two different contacts. Please reconcile them in Trackpr before this lead can be captured automatically." },
      { status: 409 },
    );
  }
  if (contactResult.outcome === "error") {
    console.error("[lead-capture] failed to resolve/create contact", { organizationId, error: contactResult.error });
    return NextResponse.json({ ok: false, error: "Could not process this lead. Please try again." }, { status: 500 });
  }

  const contactId = contactResult.contact.id;

  // Duplicate-submission guard: a retried webhook delivery or a double
  // form-submit within a short window is not a new opportunity. This is
  // intentionally a simple, existing-schema-only check (no new idempotency
  // column) - a true external-id-based idempotency key is a reasonable
  // post-launch enhancement, not required for the first contractor.
  const duplicateWindowStart = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data: recentLead } = await service
    .from("leads")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .gte("created_at", duplicateWindowStart)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentLead) {
    return NextResponse.json({ ok: true, duplicate: true, leadId: recentLead.id, contactId });
  }

  const { data: lead, error: leadInsertError } = await service
    .from("leads")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      service: serviceField,
      source: source ?? "lead_capture_api",
      status: "new",
      temperature: "cold",
    })
    .select("id")
    .single();

  if (leadInsertError || !lead) {
    console.error("[lead-capture] failed to create lead", { organizationId, contactId, error: leadInsertError?.message });
    return NextResponse.json({ ok: false, error: "Could not create this lead. Please try again." }, { status: 500 });
  }

  await emitLeadStageChangedAsService(service, organizationId, { leadId: lead.id, previousStatus: null, newStatus: "new", source: "automation" });

  await emitLeadCreatedFollowupAsService(service, {
    leadId: lead.id,
    contactId,
    organizationId,
    source: source ?? "lead_capture_api",
    service: serviceField ?? "",
    status: "new",
    temperature: "cold",
    estimatedValue: null,
  });

  return NextResponse.json({ ok: true, duplicate: false, leadId: lead.id, contactId }, { status: 201 });
}
