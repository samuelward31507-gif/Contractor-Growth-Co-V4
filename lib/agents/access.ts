import type { User } from "@supabase/supabase-js";
import type { OrganizationMembership } from "@/lib/auth/organization";
import { SPECIALIST_AGENT_IDS, type SpecialistAgentId } from "./registry";

/**
 * Agent Operating Layer: who may open the internal Command Center, decided
 * in this order before a single agent input is read:
 *
 *   1. Not signed in                 -> "unauthenticated" (sent to /login).
 *   2. Signed in, not an agency admin -> "denied": the Agency surfaces' own
 *      UnauthorizedState, nothing else rendered and nothing loaded. This
 *      is every contractor user.
 *   3. Agency admin with no organization membership -> "no_membership"
 *      (sent to /onboarding, as /agency does).
 *   4. Otherwise "granted", scoped to that verified membership's organization.
 *
 * The admin check is the existing is_agency_admin() RPC via isAgencyAdmin()
 * (lib/agency/queries.ts) - no second permission system. A failed check
 * fails closed to "denied".
 */
export type CommandCenterAccess =
  | { kind: "unauthenticated" }
  | { kind: "denied" }
  | { kind: "no_membership" }
  | { kind: "granted"; user: User; membership: OrganizationMembership };

export async function resolveCommandCenterAccess(deps: {
  getMembership: () => Promise<{ user: User | null; membership: OrganizationMembership | null }>;
  isAgencyAdmin: () => Promise<boolean>;
}): Promise<CommandCenterAccess> {
  const { user, membership } = await deps.getMembership();
  if (!user) return { kind: "unauthenticated" };
  const admin = await deps.isAgencyAdmin().catch(() => false);
  if (admin !== true) return { kind: "denied" };
  if (!membership) return { kind: "no_membership" };
  return { kind: "granted", user, membership };
}

/** The Command Center's only URL input: which specialist to drill into. Anything else is the Chief of Staff view. */
export function parseAgentView(value: unknown): SpecialistAgentId | null {
  return typeof value === "string" && (SPECIALIST_AGENT_IDS as readonly string[]).includes(value) ? (value as SpecialistAgentId) : null;
}
