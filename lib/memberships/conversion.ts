import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrganizationVertical } from "@/lib/auth/organization";
import { getLead } from "@/lib/leads/queries";
import { getMembershipsForContact, createMembership } from "./queries";
import { emitLeadStageChanged } from "@/lib/automation/lead-stage-history";
import { emitMembershipWelcomeMessage } from "@/lib/automation/membership-conversion";

export type ConvertLeadToMembershipInput = {
  organizationId: string;
  vertical: OrganizationVertical;
  leadId: string;
  userId: string;
};

export type ConvertLeadToMembershipResult =
  | { ok: true; alreadyMember: boolean; membershipId: string | null }
  | { ok: false; error: string };

/**
 * Gym Revenue Engine, Slice 2: the core conversion logic, extracted as a
 * plain function taking an already-resolved supabase client rather than
 * living inline in the Server Action (app/(app)/leads/actions.ts) - the
 * same shape lib/scheduling/booking.ts's bookAppointment and
 * lib/automation/lead-followup.ts's emitLeadCreatedFollowup already use, so
 * this can be called with either a real session client (the Server Action's
 * normal path) or, for a live integration test, a session minted for a
 * disposable test user - the codebase's own established workaround for
 * Server Actions that otherwise depend on next/headers' cookies() and can't
 * be invoked directly from a bare test script (see
 * app/onboarding/actions.payment-gate.test.ts's own documented limitation).
 *
 * Gym-only: rejected immediately for any non-gym vertical, before any
 * read/write - no membership is created, no lead is modified, no message is
 * sent. Duplicate protection: a contact that already has an active
 * membership resolves to `alreadyMember: true`, never a second membership -
 * see this function's own module for the documented, accepted residual race
 * window between two genuinely concurrent calls.
 *
 * AI/n8n never calls this function - only the staff-facing Server Action
 * does, matching this codebase's established "human confirms, AI never
 * invents" boundary.
 */
export async function convertLeadToMembership(
  supabase: SupabaseClient,
  input: ConvertLeadToMembershipInput,
): Promise<ConvertLeadToMembershipResult> {
  if (input.vertical !== "gym") {
    return { ok: false, error: "Membership conversion is only available for gym organizations." };
  }

  const lead = await getLead(supabase, input.organizationId, input.leadId);
  if (!lead || !lead.contact_id) {
    return { ok: false, error: "This lead could not be found." };
  }

  const existingMemberships = await getMembershipsForContact(supabase, input.organizationId, lead.contact_id);
  if (existingMemberships.some((existing) => existing.status === "active")) {
    return { ok: true, alreadyMember: true, membershipId: null };
  }

  const created = await createMembership(supabase, input.organizationId, {
    contact_id: lead.contact_id,
    plan_name: "General Membership",
    status: "active",
    start_at: new Date().toISOString(),
  });

  if (!created) {
    return { ok: false, error: "We couldn't create this membership. Please try again." };
  }

  if (lead.status !== "won") {
    const { error: updateError } = await supabase
      .from("leads")
      .update({ status: "won" })
      .eq("id", input.leadId)
      .eq("organization_id", input.organizationId);

    if (!updateError) {
      await emitLeadStageChanged(supabase, {
        leadId: input.leadId,
        previousStatus: lead.status,
        newStatus: "won",
        source: "manual",
        actorUserId: input.userId,
      });
    }
  }

  // Best-effort: the membership is already created and is the source of
  // truth regardless of what happens here. emitMembershipWelcomeMessage
  // never throws and logs its own failures rather than surfacing them to
  // staff - a message-send problem must never look like the conversion
  // itself failed.
  await emitMembershipWelcomeMessage(supabase, {
    organizationId: input.organizationId,
    membershipId: created.id,
    contactId: lead.contact_id,
    leadId: input.leadId,
  });

  return { ok: true, alreadyMember: false, membershipId: created.id };
}
