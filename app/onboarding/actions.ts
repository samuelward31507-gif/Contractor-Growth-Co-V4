"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { resolveOrCreateContact } from "@/lib/contacts/resolve";
import { emitLeadCreatedFollowup } from "@/lib/automation/lead-followup";
import { ONBOARDING_TEST_LEAD_SOURCE } from "@/lib/onboarding/readiness";

export type OnboardingState = {
  error?: string;
};

/**
 * First Client Onboarding V1, Step 1 (Business): still the same, unchanged
 * bootstrap_organization RPC as before - organization creation itself
 * remains self-service and tied to the creating user becoming its owner,
 * exactly as it already worked. The only change is collecting the
 * additional fields Step 1 asks for (owner/contact name, trade, phone,
 * one service area) and persisting them right after the org is created,
 * using the same session client - now permitted by organizations_update/
 * service_areas_insert's existing is_org_admin() RLS policies, since the
 * caller is that organization's owner by this point. A failure to persist
 * these extra fields is non-fatal (the org itself was already created
 * successfully) and simply means Settings/onboarding will show them as
 * still incomplete - never a reason to fail an otherwise-successful signup.
 */
export async function createOrganization(
  _prevState: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const existing = await getUserOrganization(supabase, user.id);
  if (existing) {
    redirect("/onboarding");
  }

  const businessName = String(formData.get("businessName") ?? "").trim();
  if (!businessName) {
    return { error: "Enter your business name." };
  }
  if (businessName.length > 120) {
    return { error: "Business name is too long." };
  }

  const ownerName = String(formData.get("ownerName") ?? "").trim().slice(0, 120);
  const trade = String(formData.get("trade") ?? "").trim().slice(0, 60);
  const phone = String(formData.get("phone") ?? "").trim().slice(0, 40);
  const serviceArea = String(formData.get("serviceArea") ?? "").trim().slice(0, 120);

  const { data: orgId, error: bootstrapError } = await supabase.rpc("bootstrap_organization", {
    org_name: businessName,
  });

  if (bootstrapError) {
    return { error: "We couldn't create your organization. Please try again." };
  }

  // bootstrap_organization returns the new organization's id; fall back to
  // re-resolving membership only if a given deployment's RPC signature ever
  // returns void instead - never trusted from anywhere else.
  const organizationId = typeof orgId === "string" ? orgId : (await getUserOrganization(supabase, user.id))?.organizationId;

  if (organizationId) {
    await supabase
      .from("organizations")
      .update({
        owner_name: ownerName || null,
        trade: trade || null,
        phone: phone || null,
      })
      .eq("id", organizationId);

    if (serviceArea) {
      await supabase.from("service_areas").insert({ organization_id: organizationId, name: serviceArea });
    }
  }

  redirect("/onboarding");
}

export type TestLeadState = {
  error?: string;
  success?: boolean;
};

/**
 * First Client Onboarding V1, Step 6 (Test Mode): exercises the real lead
 * lifecycle - resolveOrCreateContact, a real leads insert, and
 * emitLeadCreatedFollowup (the same session-scoped automation trigger
 * app/(app)/leads/actions.ts's createLead already uses) - never a separate,
 * fake "simulate" code path. Organization scope comes exclusively from
 * getUserOrganization(session) - never trusted from the client. Uses a
 * fixed, clearly-synthetic contact identity and a dedicated source value
 * (ONBOARDING_TEST_LEAD_SOURCE) so test leads are always identifiable and
 * never confused with a real customer. Safety is unchanged: whatever this
 * triggers still passes through the same automation event -> n8n -> outbound
 * gate pipeline as any other lead, including the organization_not_live
 * check - this action never bypasses it and never sends anything directly.
 */
export async function sendTestLead(_prevState: TestLeadState, _formData: FormData): Promise<TestLeadState> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) redirect("/onboarding");

  const organizationId = membership.organizationId;
  const testPhone = "+15555550100"; // NANPA-reserved fictional-use number, never a real subscriber - matches the test number already used during production validation.

  const contactResult = await resolveOrCreateContact(supabase, {
    organizationId,
    firstName: "Test",
    lastName: "Lead",
    phone: testPhone,
  });

  if (contactResult.outcome === "error") {
    return { error: "Could not create the test lead. Please try again." };
  }
  if (contactResult.outcome === "conflict") {
    return { error: "The test phone number is already on file for two different contacts. Please resolve this in Contacts first." };
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({
      organization_id: organizationId,
      contact_id: contactResult.contact.id,
      service: "Onboarding test lead",
      source: ONBOARDING_TEST_LEAD_SOURCE,
      status: "new",
      temperature: "cold",
    })
    .select("id")
    .single();

  if (leadError || !lead) {
    return { error: "Could not create the test lead. Please try again." };
  }

  await emitLeadCreatedFollowup(supabase, {
    leadId: lead.id,
    contactId: contactResult.contact.id,
    organizationId,
    source: ONBOARDING_TEST_LEAD_SOURCE,
    service: "Onboarding test lead",
    status: "new",
    temperature: "cold",
    estimatedValue: null,
  });

  revalidatePath("/onboarding");
  return { success: true };
}
