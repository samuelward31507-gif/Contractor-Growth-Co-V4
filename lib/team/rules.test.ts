/**
 * Phase 3 (W3): team management rules - who may invite, change roles and
 * remove, with last-owner and self-lockout protection - plus source-level
 * guards on the server actions' security properties.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/team/rules.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const rules: typeof import("./rules") = require(path.join(ROOT, "lib/team/rules.ts"));

const owner = { userId: "u-owner", role: "owner" as const };
const admin = { userId: "u-admin", role: "admin" as const };
const admin2 = { userId: "u-admin2", role: "admin" as const };
const member = { userId: "u-member", role: "member" as const };
const team = [owner, admin, admin2, member];

test("only owners and admins manage the team; invites are for Admin or Member - never Owner", () => {
  assert.deepEqual([rules.canManageTeam("owner"), rules.canManageTeam("admin"), rules.canManageTeam("member")], [true, true, false]);
  assert.deepEqual(["admin", "member", "owner", "superuser", ""].map(rules.isInvitableRole), [true, true, false, false, false]);
});

test("role changes: owners and admins switch others between Admin and Member; never their own role, never the owner, never to Owner; members can't", () => {
  assert.deepEqual(rules.decideRoleChange(owner, member, "admin"), { ok: true });
  assert.deepEqual(rules.decideRoleChange(admin, admin2, "member"), { ok: true });
  assert.equal(rules.decideRoleChange(member, admin, "member").ok, false, "members can't");
  assert.equal(rules.decideRoleChange(admin, admin, "member").ok, false, "not your own role");
  assert.equal(rules.decideRoleChange(admin, owner, "member").ok, false, "never the owner");
  assert.equal(rules.decideRoleChange(owner, member, "owner").ok, false, "never to Owner");
  assert.equal(rules.decideRoleChange(owner, undefined, "admin").ok, false, "not on this team");
});

test("removal: owners and admins remove admins and members; never themselves, never an owner (so never the last owner); members can't", () => {
  assert.deepEqual(rules.decideRemoval(owner, member, team), { ok: true });
  assert.deepEqual(rules.decideRemoval(admin, admin2, team), { ok: true });
  assert.equal(rules.decideRemoval(member, admin, team).ok, false);
  assert.equal(rules.decideRemoval(admin, admin, team).ok, false, "not yourself");
  const lastOwner = rules.decideRemoval(admin, owner, team);
  assert.deepEqual(lastOwner, { ok: false, error: "The organization's only owner can't be removed." });
  assert.equal(rules.decideRemoval(owner, undefined, team).ok, false);
});

test("server actions: invite links are INVITES only (never a sign-in link for an existing account); membership writes use the caller's RLS client; every action checks the role first", () => {
  const source = fs.readFileSync(path.join(ROOT, "app/(app)/settings/team/actions.ts"), "utf8");
  assert.doesNotMatch(source, /type: "magiclink"/, "never generates a sign-in link - that would let an admin into someone else's account");
  assert.match(source, /generateLink\(\{ type: "invite"/);
  assert.match(source, /&type=invite`/);
  for (const write of ['auth.supabase.from("organization_members").insert(', 'auth.supabase.from("organization_members").update(', 'auth.supabase.from("organization_members").delete()']) {
    assert.ok(source.includes(write), `${write} - through the caller's RLS-scoped client`);
  }
  assert.doesNotMatch(source, /service\.from\("organization_members"\)\.(insert|update|delete)/, "the service role never writes memberships");
  for (const action of ["inviteTeamMember", "regenerateInviteLink", "changeTeamMemberRole", "removeTeamMember"]) {
    const body = source.slice(source.indexOf(`export async function ${action}`));
    assert.match(body.slice(0, 400), /const auth = await requireTeamAdmin\(\);\n\s+if \("error" in auth\) return \{ error: auth\.error \};/, `${action} checks the role first`);
  }
  assert.match(source, /if \(data\?\.user\?\.last_sign_in_at\) return/, "a new link only for an invite that hasn't been accepted");
  const confirm = fs.readFileSync(path.join(ROOT, "app/auth/confirm/route.ts"), "utf8");
  assert.match(confirm, /type === "recovery" \|\| type === "invite"/, "an accepted invite goes to set a password");
});
