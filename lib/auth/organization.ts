import type { SupabaseClient } from "@supabase/supabase-js";

export type OrganizationRole = "owner" | "admin" | "member";

export type OrganizationMembership = {
  organizationId: string;
  role: OrganizationRole;
};

/**
 * Resolves the caller's own organization membership from `organization_members`,
 * scoped to a server-verified `userId` (from `supabase.auth.getUser()`). This
 * never accepts a client-supplied organization id - RLS also enforces that a
 * user can only ever see their own membership row here.
 */
export async function getUserOrganization(
  supabase: SupabaseClient,
  userId: string,
): Promise<OrganizationMembership | null> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId)
    .limit(1);

  if (error || !data || data.length === 0) {
    return null;
  }

  const [row] = data;
  return { organizationId: row.organization_id, role: row.role as OrganizationRole };
}
