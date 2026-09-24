import type { SupabaseClient } from "@supabase/supabase-js";

export type OrganizationRole = "owner" | "admin" | "member";

/** See 20260921120000_organization_payment_status.sql. 'suspended'/'cancelled' are reserved for future subscription-lifecycle handling - no code in this pass reads or writes them. */
export type OrganizationPaymentStatus = "payment_required" | "active" | "suspended" | "cancelled";

/** See 20260924100000_organization_vertical.sql (Gym Foundation Phase 1). */
export type OrganizationVertical = "contractor" | "gym";

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string | null;
  role: OrganizationRole;
  paymentStatus: OrganizationPaymentStatus;
  vertical: OrganizationVertical;
};

type EmbeddedOrganization =
  | { name: string | null; payment_status: string | null; vertical: string | null }
  | { name: string | null; payment_status: string | null; vertical: string | null }[]
  | null;

export function resolveOrganization(
  organizations: EmbeddedOrganization,
): { name: string | null; paymentStatus: OrganizationPaymentStatus; vertical: OrganizationVertical } {
  const org = Array.isArray(organizations) ? organizations[0] : organizations;
  const paymentStatus = org?.payment_status;
  const vertical = org?.vertical;
  return {
    name: org?.name ?? null,
    // Fails closed: an unrecognized/missing value is treated as still
    // gated, never as implicitly active.
    paymentStatus: paymentStatus === "active" || paymentStatus === "suspended" || paymentStatus === "cancelled" ? paymentStatus : "payment_required",
    // Fails closed the same way: an unrecognized/missing value (including
    // any future vertical the organizations_vertical_check constraint adds
    // that this code doesn't know about yet) resolves to "contractor",
    // never silently to "gym" - the application must never assume gym
    // unless the database explicitly says so.
    vertical: vertical === "gym" ? "gym" : "contractor",
  };
}

/**
 * Resolves the caller's own organization membership from `organization_members`,
 * scoped to a server-verified `userId` (from `supabase.auth.getUser()`). This
 * never accepts a client-supplied organization id - RLS also enforces that a
 * user can only ever see their own membership row here. The organization name,
 * payment_status, and vertical are embedded in the same query (PostgREST FK
 * join) so callers that need them for display/gating/nav don't need a second
 * round trip.
 */
export async function getUserOrganization(
  supabase: SupabaseClient,
  userId: string,
): Promise<OrganizationMembership | null> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id, role, organizations(name, payment_status, vertical)")
    .eq("user_id", userId)
    .limit(1);

  if (error || !data || data.length === 0) {
    return null;
  }

  const [row] = data;
  const organization = resolveOrganization(row.organizations as EmbeddedOrganization);
  return {
    organizationId: row.organization_id,
    organizationName: organization.name,
    role: row.role as OrganizationRole,
    paymentStatus: organization.paymentStatus,
    vertical: organization.vertical,
  };
}
