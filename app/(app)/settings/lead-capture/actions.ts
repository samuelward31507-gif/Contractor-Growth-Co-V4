"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

export type LeadIntakeTokenActionState = {
  error?: string;
  success?: boolean;
  /** Set only when the rotation succeeded but its audit record could not be written - same contract as the SMS number actions. */
  auditWarning?: string;
};

/**
 * Final Batch 2: deliberate rotation of organizations.lead_intake_token - the
 * credential in the public intake URL. Until an owner/admin rotates it, the
 * existing token keeps working exactly as before; after rotation the old
 * token stops resolving (the capture route answers 404) and the new URL
 * appears in Settings, so every form/webhook must be updated to it.
 *
 * Authorization mirrors app/(app)/settings/sms/actions.ts: the caller's own
 * organization from the session (never a client-supplied id), then
 * assertOrgAdmin(); organizations_update's RLS (is_org_admin) enforces the
 * same rule independently, so the write uses the caller's own session
 * client - never the service role.
 *
 * The new token is never returned, logged or written to the audit record.
 */
export async function rotateLeadIntakeToken(): Promise<LeadIntakeTokenActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) redirect("/onboarding");
  const organizationId = membership.organizationId;

  const authResult = await assertOrgAdmin(supabase, organizationId);
  if (!authResult.ok) return { error: authResult.error };

  // Same shape and strength as the column default: 24 random bytes, hex.
  const token = randomBytes(24).toString("hex");
  const { data, error } = await supabase.from("organizations").update({ lead_intake_token: token }).eq("id", organizationId).select("id");
  if (error || !data || data.length === 0) {
    console.error("[settings][lead-capture] failed to rotate intake token", { organizationId, code: error?.code ?? null });
    return { error: "We couldn't rotate your intake URL. Please try again." };
  }

  revalidatePath("/settings");
  revalidatePath("/onboarding");

  // audit_log has no client INSERT policy; the row is written with the service
  // role only after the RLS-checked update above succeeded (precedent:
  // app/api/webhooks/sms/status/route.ts).
  let auditWarning: string | undefined;
  try {
    const { error: auditError } = await createServiceRoleClient().from("audit_log").insert({
      organization_id: organizationId,
      user_id: user.id,
      action: "organization_lead_intake_token_rotated",
      entity_type: "organization",
      entity_id: organizationId,
      metadata: {},
    });
    if (auditError) throw new Error(auditError.message);
  } catch (auditFailure) {
    console.error("[settings][lead-capture] failed to record audit log entry", { organizationId, error: auditFailure instanceof Error ? auditFailure.message : "unknown error" });
    auditWarning = "The intake URL was rotated, but the audit record could not be saved.";
  }

  return { success: true, auditWarning };
}
