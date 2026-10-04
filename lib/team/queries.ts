import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrganizationRole } from "@/lib/auth/organization";

export type TeamMemberRow = {
  userId: string;
  role: OrganizationRole;
  email: string | null;
  /** True until the person has signed in for the first time (an invite not yet accepted). */
  invited: boolean;
  joinedAt: string;
};

/**
 * Phase 3 (W3): the organization's team. Memberships are read with the
 * caller's own RLS-scoped client (is_org_member); emails and sign-in state
 * come from Supabase Auth via the service role (auth.users is not readable
 * otherwise). Never exposes anything beyond email, role and whether the
 * invite has been accepted.
 */
export async function getTeamMembers(supabase: SupabaseClient, service: SupabaseClient, organizationId: string): Promise<{ members: TeamMemberRow[]; failed: boolean }> {
  const { data, error } = await supabase.from("organization_members").select("user_id, role, created_at").eq("organization_id", organizationId).order("created_at", { ascending: true });
  if (error || !data) return { members: [], failed: true };

  const members = await Promise.all(
    (data as { user_id: string; role: OrganizationRole; created_at: string }[]).map(async (row) => {
      const { data: auth } = await service.auth.admin.getUserById(row.user_id);
      const user = auth?.user ?? null;
      return { userId: row.user_id, role: row.role, email: user?.email ?? null, invited: !user?.last_sign_in_at, joinedAt: row.created_at };
    }),
  );
  return { members, failed: false };
}
