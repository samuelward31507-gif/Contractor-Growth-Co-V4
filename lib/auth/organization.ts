import type { SupabaseClient } from "@supabase/supabase-js";

export type OrganizationRole = "owner" | "admin" | "member";

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string | null;
  role: OrganizationRole;
};

type EmbeddedOrganization = { name: string | null } | { name: string | null }[] | null;

function resolveOrganizationName(organizations: EmbeddedOrganization): string | null {
  if (!organizations) return null;
  const org = Array.isArray(organizations) ? organizations[0] : organizations;
  return org?.name ?? null;
}

/**
 * Resolves the caller's own organization membership from `organization_members`,
 * scoped to a server-verified `userId` (from `supabase.auth.getUser()`). This
 * never accepts a client-supplied organization id - RLS also enforces that a
 * user can only ever see their own membership row here. The organization name
 * is embedded in the same query (PostgREST FK join) so callers that need it
 * for display don't need a second round trip.
 */
export async function getUserOrganization(
  supabase: SupabaseClient,
  userId: string,
): Promise<OrganizationMembership | null> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id, role, organizations(name)")
    .eq("user_id", userId)
    .limit(1);

  if (error || !data || data.length === 0) {
    return null;
  }

  const [row] = data;
  return {
    organizationId: row.organization_id,
    organizationName: resolveOrganizationName(row.organizations as EmbeddedOrganization),
    role: row.role as OrganizationRole,
  };
}
