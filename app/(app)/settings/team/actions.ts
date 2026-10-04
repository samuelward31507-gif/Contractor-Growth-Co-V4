"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserOrganization } from "@/lib/auth/organization";
import { isValidEmail } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { canManageTeam, decideRemoval, decideRoleChange, isInvitableRole, type TeamMember } from "@/lib/team/rules";

/**
 * Phase 3 (W3): team invites by copyable link - Trackpr sends no email. An
 * owner or admin invites someone by email as Admin or Member; the result is a
 * one-time sign-in link the owner sends to that person themselves. The link
 * lands on /auth/confirm, which verifies it and (for a new account) sends the
 * person to set their password. Membership writes use the caller's own
 * RLS-scoped client (organization_members: is_org_admin); only the Supabase
 * Auth admin calls (creating the invited account, generating the link,
 * reading emails) use the service role. The rules in lib/team/rules.ts sit on
 * top of RLS.
 */
export type TeamActionState = { error?: string; success?: string; inviteLink?: string; inviteEmail?: string };

async function requireTeamAdmin(): Promise<{ supabase: Awaited<ReturnType<typeof createClient>>; organizationId: string; actor: TeamMember } | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) redirect("/onboarding");
  if (!canManageTeam(membership.role)) return { error: "Only owners and admins can manage the team." };
  return { supabase, organizationId: membership.organizationId, actor: { userId: user.id, role: membership.role } };
}

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin.replace(/\/+$/, "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * A one-time invite link for this email. SECURITY: only ever an INVITE - for
 * an email with no Trackpr account yet (Supabase creates it), or an invited
 * account that has never signed in (Supabase re-invites it). A sign-in
 * ("magic") link for an existing, active account is never generated here:
 * that would hand an admin a way into someone else's account.
 */
async function generateInviteLink(service: SupabaseClient, email: string, origin: string): Promise<{ userId: string; link: string } | { error: string; existingAccount?: true }> {
  const result = await service.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: `${origin}/auth/confirm` } });
  if (result.error) {
    const existingAccount = result.error.code === "email_exists" || /already been registered|already registered/i.test(result.error.message);
    if (!existingAccount) console.error("[team] could not generate an invite link", { error: result.error.message });
    return existingAccount
      ? { error: "That email already has a Trackpr account. Invites are for new accounts - use a different email.", existingAccount: true }
      : { error: "We couldn't create an invite link right now. Please try again." };
  }
  if (!result.data.user || !result.data.properties?.hashed_token) return { error: "We couldn't create an invite link right now. Please try again." };
  return { userId: result.data.user.id, link: `${origin}/auth/confirm?token_hash=${encodeURIComponent(result.data.properties.hashed_token)}&type=invite` };
}

async function loadTeam(supabase: SupabaseClient, organizationId: string): Promise<TeamMember[]> {
  const { data } = await supabase.from("organization_members").select("user_id, role").eq("organization_id", organizationId);
  return ((data ?? []) as { user_id: string; role: TeamMember["role"] }[]).map((row) => ({ userId: row.user_id, role: row.role }));
}

export async function inviteTeamMember(_prev: TeamActionState, formData: FormData): Promise<TeamActionState> {
  const auth = await requireTeamAdmin();
  if ("error" in auth) return { error: auth.error };
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "");
  if (!isValidEmail(email)) return { error: "Enter a valid email address." };
  if (!isInvitableRole(role)) return { error: "Choose Admin or Member." };

  const service = createServiceRoleClient();
  const access = await generateInviteLink(service, email, await requestOrigin());
  if ("error" in access) return { error: access.error };

  // One workspace per person: getUserOrganization resolves a single membership.
  const { data: existing } = await service.from("organization_members").select("organization_id").eq("user_id", access.userId).limit(1);
  if (existing && existing.length > 0) {
    return existing[0].organization_id === auth.organizationId ? { error: "That person is already on your team." } : { error: "That email already belongs to another Trackpr workspace." };
  }

  const { error } = await auth.supabase.from("organization_members").insert({ organization_id: auth.organizationId, user_id: access.userId, role });
  if (error) {
    console.error("[team] could not add the member", { error: error.message });
    return { error: "We couldn't add that person. Please try again." };
  }
  revalidatePath("/settings");
  return { success: "Invite ready - copy the link and send it to them.", inviteLink: access.link, inviteEmail: email };
}

export async function regenerateInviteLink(_prev: TeamActionState, formData: FormData): Promise<TeamActionState> {
  const auth = await requireTeamAdmin();
  if ("error" in auth) return { error: auth.error };
  const userId = String(formData.get("userId") ?? "");
  const team = await loadTeam(auth.supabase, auth.organizationId);
  if (!team.some((member) => member.userId === userId)) return { error: "That person is not on this team." };

  const service = createServiceRoleClient();
  const { data } = await service.auth.admin.getUserById(userId);
  const email = data?.user?.email;
  if (!email) return { error: "We couldn't find that person's email." };
  // Only for an invite that hasn't been accepted - an active account signs in with its own password.
  if (data?.user?.last_sign_in_at) return { error: "They've already joined - they can sign in with their own password." };
  const access = await generateInviteLink(service, email, await requestOrigin());
  if ("error" in access) return { error: access.error };
  return { success: "New link ready - copy it and send it to them.", inviteLink: access.link, inviteEmail: email };
}

export async function changeTeamMemberRole(_prev: TeamActionState, formData: FormData): Promise<TeamActionState> {
  const auth = await requireTeamAdmin();
  if ("error" in auth) return { error: auth.error };
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  const team = await loadTeam(auth.supabase, auth.organizationId);
  const decision = decideRoleChange(auth.actor, team.find((member) => member.userId === userId), role);
  if (!decision.ok) return { error: decision.error };

  const { error } = await auth.supabase.from("organization_members").update({ role }).eq("organization_id", auth.organizationId).eq("user_id", userId);
  if (error) return { error: "We couldn't change that role. Please try again." };
  revalidatePath("/settings");
  return { success: "Role updated." };
}

export async function removeTeamMember(_prev: TeamActionState, formData: FormData): Promise<TeamActionState> {
  const auth = await requireTeamAdmin();
  if ("error" in auth) return { error: auth.error };
  const userId = String(formData.get("userId") ?? "");
  const team = await loadTeam(auth.supabase, auth.organizationId);
  const decision = decideRemoval(auth.actor, team.find((member) => member.userId === userId), team);
  if (!decision.ok) return { error: decision.error };

  const { error } = await auth.supabase.from("organization_members").delete().eq("organization_id", auth.organizationId).eq("user_id", userId);
  if (error) return { error: "We couldn't remove that person. Please try again." };
  revalidatePath("/settings");
  return { success: "Removed from the team." };
}
