"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { createClient } from "@/lib/supabase/server";
import { validateSmsPhoneNumber } from "@/lib/settings/sms-routing";

export type SmsRoutingActionState = {
  error?: string;
  success?: boolean;
  /**
   * Set only when the organizations mutation itself succeeded but the audit
   * record could not be written - matches app/(app)/automations/actions.ts's
   * own auditWarning precedent exactly: the mutation is never rolled back
   * for an audit failure, but the caller must never be told the action was
   * audited when it silently wasn't.
   */
  auditWarning?: string;
};

/**
 * Resolves the caller's own organization the same way every other
 * authenticated mutation in this app does (auth.uid() -> organization_members
 * via getUserOrganization, never a client-supplied id), then requires
 * owner/admin via assertOrgAdmin() - the same RPC-backed authorization gate
 * app/(app)/automations/actions.ts already uses, unchanged here. This is
 * defense in depth on top of organizations_update's own RLS policy
 * (is_org_admin(id), verified in Phase 1 of this feature's audit), never a
 * replacement for it - a bug here can, at worst, produce a confusing error
 * message, never an unauthorized write, because RLS enforces the same rule
 * independently at the database layer.
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

async function recordAudit(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  action: "organization_sms_number_updated" | "organization_sms_number_cleared",
): Promise<string | undefined> {
  const { error } = await supabase.rpc("create_organization_audit_event", {
    p_organization_id: organizationId,
    p_action: action,
    p_metadata: {},
  });

  if (error) {
    console.error("[settings][sms] failed to record audit log entry", { organizationId, action, error: error.message });
    return "The number was saved, but the audit record could not be saved.";
  }

  return undefined;
}

export async function updateSmsPhoneNumber(
  _prevState: SmsRoutingActionState,
  formData: FormData,
): Promise<SmsRoutingActionState> {
  const session = await requireOrgAdmin();
  if (!session.ok) return { error: session.error };
  const { supabase, organizationId } = session;

  const raw = String(formData.get("smsPhoneNumber") ?? "");
  const validation = validateSmsPhoneNumber(raw);
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { error } = await supabase.from("organizations").update({ sms_phone_number: validation.value }).eq("id", organizationId);

  if (error) {
    // 23505 = unique_violation - the partial unique index on
    // sms_phone_number (see the Phase 5 migration). Deliberately generic:
    // never confirms or denies which other organization holds the number.
    if (error.code === "23505") {
      return { error: "This number is already in use by another account. Contact support if you believe this is a mistake." };
    }
    return { error: "We couldn't save your SMS number. Please try again." };
  }

  revalidatePath("/settings/sms");
  const auditWarning = await recordAudit(supabase, organizationId, "organization_sms_number_updated");
  return { success: true, auditWarning };
}

export async function clearSmsPhoneNumber(
  _prevState: SmsRoutingActionState,
  _formData: FormData,
): Promise<SmsRoutingActionState> {
  const session = await requireOrgAdmin();
  if (!session.ok) return { error: session.error };
  const { supabase, organizationId } = session;

  const { error } = await supabase.from("organizations").update({ sms_phone_number: null }).eq("id", organizationId);

  if (error) {
    return { error: "We couldn't clear your SMS number. Please try again." };
  }

  revalidatePath("/settings/sms");
  const auditWarning = await recordAudit(supabase, organizationId, "organization_sms_number_cleared");
  return { success: true, auditWarning };
}
