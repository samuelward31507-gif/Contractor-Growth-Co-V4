"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { resolveAgencyOrganizations } from "@/lib/agency/queries";

export type SetAutomationPausedState = {
  error?: string;
  success?: boolean;
};

/**
 * Launch Blocker #5: the founder-facing automation kill switch. Pauses or
 * resumes a client organization's automated outbound messaging/automation -
 * real enforcement happens in lib/automation/outbound-gate.ts, re-checked
 * live on every send; this action only ever flips the persisted flag that
 * gate reads.
 *
 * Defense in depth, matching this codebase's existing "verify at every
 * layer" philosophy: this Server Action independently re-verifies the
 * caller is a real agency admin AND that the target organization is one
 * this agency actually manages, using the exact same
 * resolveAgencyOrganizations() chokepoint every other agency read already
 * goes through - never a second, divergent authorization path. The
 * database RPC called below then re-verifies both of those facts again,
 * for itself, from inside its own SECURITY DEFINER context - a caller that
 * somehow got past this action's own check still cannot get the database
 * to act without passing the RPC's own checks too.
 *
 * organizationId and paused both come from hidden form fields the server
 * itself rendered (see automation-pause-control.tsx) - never trusted
 * merely because they're present; this action re-derives authorization
 * independently of what the client claims either value to be.
 */
export async function setAutomationPaused(
  _prevState: SetAutomationPausedState,
  formData: FormData,
): Promise<SetAutomationPausedState> {
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  const paused = formData.get("paused") === "true";

  if (!organizationId) {
    return { error: "Missing organization." };
  }

  const supabase = await createClient();
  const service = createServiceRoleClient();

  const resolved = await resolveAgencyOrganizations(supabase, service);
  if (!resolved.ok) {
    return { error: "Not authorized." };
  }

  const isAuthorizedOrganization = resolved.organizations.some((org) => org.organizationId === organizationId);
  if (!isAuthorizedOrganization) {
    // Identical error to the auth failure above - never confirms or denies
    // whether an organization id outside this agency's own set exists at
    // all, matching how the org detail page itself already behaves.
    return { error: "Not authorized." };
  }

  const { error } = await supabase.rpc("set_organization_automation_paused", {
    p_organization_id: organizationId,
    p_paused: paused,
  });

  if (error) {
    return { error: "We couldn't update this organization's automation state. Please try again." };
  }

  revalidatePath(`/agency/organizations/${organizationId}`);
  return { success: true };
}
