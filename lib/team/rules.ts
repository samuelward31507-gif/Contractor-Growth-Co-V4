import type { OrganizationRole } from "@/lib/auth/organization";

/**
 * Phase 3 (W3): who may change the team, and how. The existing
 * owner / admin / member roles and organization_members RLS
 * (is_org_admin for insert / update / delete) are unchanged; these rules sit
 * on top of RLS in the server actions. Pure, so they are unit tested directly.
 *
 * - Only owners and admins manage the team; members never do.
 * - An invite is for admin or member - ownership is never granted here.
 * - Nobody changes their own role or removes themselves (no self-lockout).
 * - An owner's row is never demoted or removed here, so the organization can
 *   never lose its last owner.
 */
export type TeamMember = { userId: string; role: OrganizationRole };

export const INVITABLE_ROLES = ["admin", "member"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const ROLE_LABEL: Record<OrganizationRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function canManageTeam(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

export function isInvitableRole(role: string): role is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(role);
}

export type TeamDecision = { ok: true } | { ok: false; error: string };

export function decideRoleChange(actor: TeamMember, target: TeamMember | undefined, newRole: string): TeamDecision {
  if (!canManageTeam(actor.role)) return { ok: false, error: "Only owners and admins can manage the team." };
  if (!target) return { ok: false, error: "That person is not on this team." };
  if (!isInvitableRole(newRole)) return { ok: false, error: "Choose Admin or Member." };
  if (target.userId === actor.userId) return { ok: false, error: "You can't change your own role." };
  if (target.role === "owner") return { ok: false, error: "The owner's role can't be changed here." };
  return { ok: true };
}

export function decideRemoval(actor: TeamMember, target: TeamMember | undefined, members: TeamMember[]): TeamDecision {
  if (!canManageTeam(actor.role)) return { ok: false, error: "Only owners and admins can manage the team." };
  if (!target) return { ok: false, error: "That person is not on this team." };
  if (target.userId === actor.userId) return { ok: false, error: "You can't remove yourself." };
  if (target.role === "owner") {
    const owners = members.filter((member) => member.role === "owner").length;
    return owners <= 1 ? { ok: false, error: "The organization's only owner can't be removed." } : { ok: false, error: "An owner can't be removed here." };
  }
  return { ok: true };
}
