"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { LEAD_STATUSES, LEAD_TEMPERATURES, type LeadStatus, type LeadTemperature } from "@/lib/leads/queries";
import { emitLeadCreatedFollowup } from "@/lib/automation/lead-followup";
import { emitLeadLost } from "@/lib/automation/lead-lost";

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

  return { supabase, organizationId: membership.organizationId };
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

  const { supabase, organizationId } = await requireOrganization();

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
  revalidatePath("/dashboard");
  return { success: true };
}

export async function updateLead(_prevState: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing lead." };
  }

  const { input, error } = parseLeadForm(formData);
  if (error || !input) return { error: error ?? "Enter lead details." };

  const { supabase, organizationId } = await requireOrganization();

  const contactValid = await verifyContactInOrganization(supabase, organizationId, input.contact_id);
  if (!contactValid) {
    return { error: "Select a valid contact." };
  }

  // Read before write: Phase 4.8's lead.lost lifecycle event must only
  // fire on a genuine NEW transition into 'lost', never on every save of
  // an already-lost lead (requirement C) - this is the only way to know
  // the lead's previous status, since updateLead is a single generic
  // update covering every field, not a dedicated status-transition action.
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

  if (previous && previous.status !== "lost" && input.status === "lost") {
    await emitLeadLost(supabase, id);
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  revalidatePath("/dashboard");
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
  revalidatePath("/dashboard");
  redirect("/leads");
}
