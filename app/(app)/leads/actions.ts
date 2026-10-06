"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { LEAD_STATUSES, LEAD_TEMPERATURES, type LeadStatus, type LeadTemperature } from "@/lib/leads/queries";
import { emitLeadCreatedFollowup } from "@/lib/automation/lead-followup";
import { emitLeadLost } from "@/lib/automation/lead-lost";
import { emitLeadStageChanged } from "@/lib/automation/lead-stage-history";
import { convertLeadToMembership as runLeadToMembershipConversion } from "@/lib/memberships/conversion";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { isCustomerReplySimulationEnvironment } from "@/lib/messaging/simulate-customer-reply";
import { dispatchFollowup } from "@/lib/followups/engine";
import { describeDispatchOutcome } from "@/lib/followups/format";

export type LeadFormState = {
  error?: string;
  success?: boolean;
};

export type DeleteLeadState = {
  error?: string;
};

type LeadInput = {
  contact_id: string;
  service: string;
  source: string | null;
  status: LeadStatus;
  temperature: LeadTemperature;
  estimated_value: number | null;
};

const VALID_STATUSES = new Set<string>(LEAD_STATUSES.map((item) => item.value));
const VALID_TEMPERATURES = new Set<string>(LEAD_TEMPERATURES.map((item) => item.value));

type ParsedLeadForm = { input: LeadInput; error?: undefined } | { input?: undefined; error: string };

function parseLeadForm(formData: FormData): ParsedLeadForm {
  const contactId = String(formData.get("contactId") ?? "").trim();
  const service = String(formData.get("service") ?? "").trim();
  const source = String(formData.get("source") ?? "").trim();
  const statusRaw = String(formData.get("status") ?? "new").trim();
  const temperatureRaw = String(formData.get("temperature") ?? "cold").trim();
  const estimatedValueRaw = String(formData.get("estimatedValue") ?? "").trim();

  if (!contactId) {
    return { error: "Select a contact for this lead." };
  }

  if (!service) {
    return { error: "Enter a service or description for this opportunity." };
  }

  const status = (VALID_STATUSES.has(statusRaw) ? statusRaw : "new") as LeadStatus;
  const temperature = (VALID_TEMPERATURES.has(temperatureRaw) ? temperatureRaw : "cold") as LeadTemperature;

  let estimatedValue: number | null = null;
  if (estimatedValueRaw) {
    const parsed = Number(estimatedValueRaw);
    if (!Number.isFinite(parsed)) {
      return { error: "Enter a valid estimated value." };
    }
    if (parsed < 0) {
      return { error: "Estimated value cannot be negative." };
    }
    estimatedValue = parsed;
  }

  return {
    input: {
      contact_id: contactId,
      service,
      source: source || null,
      status,
      temperature,
      estimated_value: estimatedValue,
    },
  };
}

/**
 * Resolves the caller's organization the same way every other authenticated
 * route in this app does (auth.uid() -> organization_members). Never trusts
 * a client-supplied organization id.
 */
async function requireOrganization() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  return { supabase, organizationId: membership.organizationId, userId: user.id, vertical: membership.vertical };
}

/**
 * Confirms the selected contact actually belongs to the caller's own
 * organization before it can be attached to a lead. RLS already prevents
 * reading another org's contact, but this makes the guarantee explicit at
 * the application layer rather than assuming RLS alone makes an otherwise
 * unsafe write safe.
 */
async function verifyContactInOrganization(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  return Boolean(data);
}

export async function createLead(_prevState: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const { input, error } = parseLeadForm(formData);
  if (error || !input) return { error: error ?? "Enter lead details." };

  const { supabase, organizationId, userId } = await requireOrganization();

  const contactValid = await verifyContactInOrganization(supabase, organizationId, input.contact_id);
  if (!contactValid) {
    return { error: "Select a valid contact." };
  }

  const { data: lead, error: insertError } = await supabase
    .from("leads")
    .insert({ ...input, organization_id: organizationId })
    .select("id")
    .single();

  if (insertError || !lead) {
    return { error: "We couldn't create this lead. Please try again." };
  }

  // Growth System Completion Pass 2 (Part 1): the first lead-stage-history
  // entry - previousStatus: null marks this as the lead's origin, never a
  // real transition from some prior stage.
  await emitLeadStageChanged(supabase, { leadId: lead.id, previousStatus: null, newStatus: input.status, source: "manual", actorUserId: userId });

  // Best-effort: the lead is already created and is the source of truth
  // regardless of what happens here. emitLeadCreatedFollowup never throws
  // and logs its own failures rather than surfacing them to the contractor.
  await emitLeadCreatedFollowup(supabase, {
    leadId: lead.id,
    contactId: input.contact_id,
    organizationId,
    source: input.source,
    service: input.service,
    status: input.status,
    temperature: input.temperature,
    estimatedValue: input.estimated_value,
  });

  revalidatePath("/leads");
  revalidatePath("/today");
  return { success: true };
}

export async function updateLead(_prevState: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing lead." };
  }

  const { input, error } = parseLeadForm(formData);
  if (error || !input) return { error: error ?? "Enter lead details." };

  const { supabase, organizationId, userId } = await requireOrganization();

  const contactValid = await verifyContactInOrganization(supabase, organizationId, input.contact_id);
  if (!contactValid) {
    return { error: "Select a valid contact." };
  }

  // Read before write: Phase 4.8's lead.lost lifecycle event must only
  // fire on a genuine NEW transition into 'lost', never on every save of
  // an already-lost lead (requirement C) - this is the only way to know
  // the lead's previous status, since updateLead is a single generic
  // update covering every field, not a dedicated status-transition action.
  // Growth System Completion Pass 2 (Part 1) reuses this exact same
  // read-before-write for lead-stage history - one comparison, two uses.
  const { data: previous } = await supabase
    .from("leads")
    .select("status")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  const { data, error: updateError } = await supabase
    .from("leads")
    .update(input)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    return { error: "We couldn't save these changes. Please try again." };
  }

  if (!data) {
    return { error: "This lead could not be found." };
  }

  if (previous && previous.status !== input.status) {
    await emitLeadStageChanged(supabase, { leadId: id, previousStatus: previous.status as LeadStatus, newStatus: input.status, source: "manual", actorUserId: userId });
  }

  if (previous && previous.status !== "lost" && input.status === "lost") {
    await emitLeadLost(supabase, id);
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  revalidatePath("/today");
  return { success: true };
}

export async function deleteLead(_prevState: DeleteLeadState, formData: FormData): Promise<DeleteLeadState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing lead." };
  }

  const { supabase, organizationId } = await requireOrganization();

  const { data, error: deleteError } = await supabase
    .from("leads")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (deleteError) {
    if (deleteError.code === "23503") {
      return {
        error: "This lead can't be deleted yet because other records still reference it.",
      };
    }
    return { error: "We couldn't delete this lead. Please try again." };
  }

  if (!data) {
    return { error: "This lead could not be found." };
  }

  revalidatePath("/leads");
  revalidatePath("/today");
  redirect("/leads");
}

export type ConvertLeadState = {
  error?: string;
  success?: boolean;
  /** Distinguishes "converted just now" from "this contact was already an active member" - both are a safe, non-error outcome, but the UI can word them differently. */
  alreadyMember?: boolean;
};

/**
 * Gym Revenue Engine, Slice 2: thin Server Action wrapper - resolves the
 * caller's own organization/vertical/user the same way every other action
 * in this file does, then delegates to the real conversion logic in
 * lib/memberships/conversion.ts (a plain function taking `supabase`
 * directly, not cookie-bound, so it can also be exercised by a live
 * integration test - see that module's own comment for why this split
 * exists).
 */
export async function convertLeadToMembership(_prevState: ConvertLeadState, formData: FormData): Promise<ConvertLeadState> {
  const leadId = String(formData.get("leadId") ?? "").trim();
  if (!leadId) {
    return { error: "Missing lead." };
  }

  const { supabase, organizationId, userId, vertical } = await requireOrganization();

  const result = await runLeadToMembershipConversion(supabase, { organizationId, vertical, leadId, userId });
  if (!result.ok) {
    return { error: result.error };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/today");
  return { success: true, alreadyMember: result.alreadyMember };
}

export type RunFollowupNowState = { error?: string; result?: string };

/**
 * P0 A4: TEST-only "Run now" for a lead's follow-up. Runs the ONE dispatcher
 * path (dispatchFollowup with runNow) - claim/lease, reply and lifecycle
 * exits, dormancy, business-hours deferral, idempotent touch, outbound gate,
 * A2 execution recording - only skipping the wait for the due time. Gated
 * exactly like Simulate Customer Reply: a non-production deployment, an org
 * owner/admin, and the organization in TEST mode (where the gate's
 * organization_not_live check means nothing is ever sent). The service-role
 * client is used only after those checks, because follow-up writes are
 * server-side only.
 */
export async function runFollowupNow(_prevState: RunFollowupNowState, formData: FormData): Promise<RunFollowupNowState> {
  if (!isCustomerReplySimulationEnvironment()) {
    return { error: "Run now is only available on test deployments." };
  }
  const followupId = String(formData.get("followupId") ?? "");
  if (!followupId) return { error: "Missing follow-up." };

  const { supabase, organizationId } = await requireOrganization();
  const admin = await assertOrgAdmin(supabase, organizationId);
  if (!admin.ok) return { error: admin.error };

  const { data: organization } = await supabase.from("organizations").select("automation_mode").eq("id", organizationId).maybeSingle();
  if (organization?.automation_mode !== "test") {
    return { error: "Run now is only available while automations are in TEST mode." };
  }

  const { data: followup } = await supabase.from("followups").select("id, lead_id").eq("id", followupId).eq("organization_id", organizationId).maybeSingle();
  if (!followup) return { error: "This follow-up could not be found." };

  const outcome = await dispatchFollowup(createServiceRoleClient(), followup.id as string, new Date(), { runNow: true });
  // The panel lives on the lead's person page (/leads/:id only redirects there).
  const { data: lead } = await supabase.from("leads").select("contact_id").eq("id", followup.lead_id as string).eq("organization_id", organizationId).maybeSingle();
  if (lead?.contact_id) revalidatePath(`/people/${lead.contact_id as string}`);
  return { result: describeDispatchOutcome(outcome) };
}
