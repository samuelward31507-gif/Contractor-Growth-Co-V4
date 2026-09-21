import type { SupabaseClient } from "@supabase/supabase-js";

export type OrganizationRole = "owner" | "admin" | "member";

/** See 20260921120000_organization_payment_status.sql. 'suspended'/'cancelled' are reserved for future subscription-lifecycle handling - no code in this pass reads or writes them. */
export type OrganizationPaymentStatus = "payment_required" | "active" | "suspended" | "cancelled";

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string | null;
  role: OrganizationRole;
  paymentStatus: OrganizationPaymentStatus;
};

type EmbeddedOrganization = { name: string | null; payment_status: string | null } | { name: string | null; payment_status: string | null }[] | null;

function resolveOrganization(organizations: EmbeddedOrganization): { name: string | null; paymentStatus: OrganizationPaymentStatus } {
  const org = Array.isArray(organizations) ? organizations[0] : organizations;
  const paymentStatus = org?.payment_status;
  return {
    name: org?.name ?? null,
    // Fails closed: an unrecognized/missing value is treated as still
    // gated, never as implicitly active.
    paymentStatus: paymentStatus === "active" || paymentStatus === "suspended" || paymentStatus === "cancelled" ? paymentStatus : "payment_required",
  };
}

/**
 * Resolves the caller's own organization membership from `organization_members`,
 * scoped to a server-verified `userId` (from `supabase.auth.getUser()`). This
 * never accepts a client-supplied organization id - RLS also enforces that a
 * user can only ever see their own membership row here. The organization name
 * and payment_status are embedded in the same query (PostgREST FK join) so
 * callers that need them for display/gating don't need a second round trip.
 */
export async function getUserOrganization(
  supabase: SupabaseClient,
  userId: string,
): Promise<OrganizationMembership | null> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id, role, organizations(name, payment_status)")
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
  };
}
