"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { createClient } from "@/lib/supabase/server";

export type MergeContactsResult = { ok: true; targetContactId: string } | { ok: false; error: string };

/**
 * Owner/admin only, matching the product requirement exactly - contacts'
 * own RLS (is_org_member) intentionally allows any member to read/update a
 * contact directly, but merging is a distinct, higher-stakes operation with
 * its own authorization boundary here, re-verified independently by
 * merge_contacts() itself (never trusting that this check already ran).
 */
async function requireOrgAdmin() {
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

  const authResult = await assertOrgAdmin(supabase, membership.organizationId);
  if (!authResult.ok) {
    return { ok: false as const, error: authResult.error };
  }

  return { ok: true as const, supabase, organizationId: membership.organizationId };
}

/**
 * The only sanctioned way to merge two contacts. Delegates the entire
 * operation to merge_contacts() (see the Contact Deduplication V1
 * migration) - a single SECURITY DEFINER transaction that re-verifies
 * organization/admin authorization itself, reassigns every real
 * relationship, and writes the audit_log row. This action's own job is
 * only to resolve the caller's organization server-side (never trust a
 * client-supplied one) and translate the result for the UI.
 */
export async function mergeContacts(sourceContactId: string, targetContactId: string, reason: string): Promise<MergeContactsResult> {
  const session = await requireOrgAdmin();
  if (!session.ok) return { ok: false, error: session.error };
  const { supabase, organizationId } = session;

  if (!sourceContactId || !targetContactId) {
    return { ok: false, error: "Select both a source and a target contact." };
  }

  const { error } = await supabase.rpc("merge_contacts", {
    p_organization_id: organizationId,
    p_source_contact_id: sourceContactId,
    p_target_contact_id: targetContactId,
    p_reason: reason.trim() || null,
  });

  if (error) {
    return { ok: false, error: error.message || "We couldn't complete this merge. Please try again." };
  }

  revalidatePath("/contacts/duplicates");
  return { ok: true, targetContactId };
}
