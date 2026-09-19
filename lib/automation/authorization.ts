import type { SupabaseClient } from "@supabase/supabase-js";

export type AssertOrgAdminResult = { ok: true; userId: string } | { ok: false; error: string };

/**
 * The single authorization gate every Automation Control Center V2 mutation
 * (enable/disable, config changes, manual run, retry - none implemented
 * yet) must call before touching anything. Resolves the caller from the
 * session's own `auth.getUser()` - never a client-supplied user id - then
 * defers entirely to the existing `is_org_admin(organization_id)` SECURITY
 * DEFINER RPC, the same authority every other admin-mutated settings table
 * in this codebase already relies on (see `services`' own
 * `services_update`/`services_insert` RLS policies). This function
 * deliberately re-implements no membership/role logic of its own: a second,
 * separate `organization_members` lookup here would just be a second source
 * of truth that could drift from the RPC's own logic, not a stronger check.
 *
 * Fails closed on every branch: no session, an RPC error, or any RPC result
 * other than literally `true` are all treated as "not authorized" - there is
 * no default-allow path. There is also no fallback through
 * `agency_admins`/`is_agency_admin()` anywhere in this function - it never
 * queries that table at all, so an agency admin who is not also an
 * owner/admin member of this exact organization is rejected the same way
 * any other non-admin caller is, not through special-case logic but because
 * `is_org_admin()` itself has no awareness of `agency_admins`. Agency
 * Command Center remains read-only; this function is never a path to
 * cross-org mutation for it.
 */
export async function assertOrgAdmin(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<AssertOrgAdminResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not authenticated." };
  }

  const { data, error } = await supabase.rpc("is_org_admin", { target_org_id: organizationId });

  if (error || data !== true) {
    return { ok: false, error: "You must be an owner or admin of this organization." };
  }

  return { ok: true, userId: user.id };
}
