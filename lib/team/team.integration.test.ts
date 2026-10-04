/**
 * Phase 3 (W3): team access on the TEST project - organization_members RLS
 * for each role (owner / admin / member), organization isolation, and the
 * invite token flow end to end (generate -> verify -> set password). Uses
 * disposable organizations and disposable TEST auth users with generated
 * passwords; everything is deleted in after().
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/team/team.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("This integration test runs against the TEST project only.");

const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const anonClient = () => createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

const tag = randomUUID().slice(0, 8);
const orgs: string[] = [];
const users: string[] = [];
const sessions: Record<string, SupabaseClient> = {};
const ids: Record<string, string> = {};
let orgA = "";
let orgB = "";

async function makeUser(label: string): Promise<string> {
  const email = `team-${label}-${tag}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  users.push(data.user!.id);
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signIn.error);
  sessions[label] = client;
  return data.user!.id;
}

before(async () => {
  for (const name of ["Team RLS Test Org A (Phase 3)", "Team RLS Test Org B (Phase 3)"]) {
    const { data, error } = await service.from("organizations").insert({ name, payment_status: "active" }).select("id").single();
    assert.ifError(error);
    orgs.push(data!.id);
  }
  [orgA, orgB] = orgs;
  for (const label of ["owner", "admin", "member", "outsider", "newcomer", "newcomer2"]) ids[label] = await makeUser(label);
  const { error } = await service.from("organization_members").insert([
    { organization_id: orgA, user_id: ids.owner, role: "owner" },
    { organization_id: orgA, user_id: ids.admin, role: "admin" },
    { organization_id: orgA, user_id: ids.member, role: "member" },
    { organization_id: orgB, user_id: ids.outsider, role: "owner" },
  ]);
  assert.ifError(error);
});

after(async () => {
  for (const orgId of orgs) {
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of users) await service.auth.admin.deleteUser(userId);
});

const roleOf = async (userId: string) => (await service.from("organization_members").select("role").eq("organization_id", orgA).eq("user_id", userId).maybeSingle()).data?.role ?? null;

test("member: sees the team but cannot add, change or remove anyone (RLS)", async () => {
  const member = sessions.member;
  const { data: visible } = await member.from("organization_members").select("user_id").eq("organization_id", orgA);
  assert.equal(visible?.length, 3, "members can see their own team");
  const insert = await member.from("organization_members").insert({ organization_id: orgA, user_id: ids.newcomer, role: "member" });
  assert.ok(insert.error, "insert refused");
  await member.from("organization_members").update({ role: "admin" }).eq("organization_id", orgA).eq("user_id", ids.member);
  assert.equal(await roleOf(ids.member), "member", "cannot promote themselves");
  await member.from("organization_members").delete().eq("organization_id", orgA).eq("user_id", ids.admin);
  assert.equal(await roleOf(ids.admin), "admin", "cannot remove anyone");
});

test("admin: adds a member, changes their role and removes them (RLS)", async () => {
  const admin = sessions.admin;
  assert.ifError((await admin.from("organization_members").insert({ organization_id: orgA, user_id: ids.newcomer, role: "member" })).error);
  assert.equal(await roleOf(ids.newcomer), "member");
  assert.ifError((await admin.from("organization_members").update({ role: "admin" }).eq("organization_id", orgA).eq("user_id", ids.newcomer)).error);
  assert.equal(await roleOf(ids.newcomer), "admin");
  assert.ifError((await admin.from("organization_members").delete().eq("organization_id", orgA).eq("user_id", ids.newcomer)).error);
  assert.equal(await roleOf(ids.newcomer), null);
});

test("owner: adds and removes a member (RLS)", async () => {
  const owner = sessions.owner;
  assert.ifError((await owner.from("organization_members").insert({ organization_id: orgA, user_id: ids.newcomer, role: "member" })).error);
  assert.equal(await roleOf(ids.newcomer), "member");
  assert.ifError((await owner.from("organization_members").delete().eq("organization_id", orgA).eq("user_id", ids.newcomer)).error);
  assert.equal(await roleOf(ids.newcomer), null);
});

test("organization isolation: another organization's owner can neither see nor change this team", async () => {
  const outsider = sessions.outsider;
  const { data: visible } = await outsider.from("organization_members").select("user_id").eq("organization_id", orgA);
  assert.equal(visible?.length ?? 0, 0);
  assert.ok((await outsider.from("organization_members").insert({ organization_id: orgA, user_id: ids.newcomer, role: "member" })).error);
  await outsider.from("organization_members").delete().eq("organization_id", orgA).eq("user_id", ids.member);
  assert.equal(await roleOf(ids.member), "member");
});

test("invite flow: a generated invite token verifies to a session for the new account, which can then set its password", async () => {
  const email = `team-invitee-${tag}@example.com`;
  const { data, error } = await service.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: "http://localhost:3000/auth/confirm" } });
  assert.ifError(error);
  users.push(data.user!.id);
  assert.equal(data.properties!.verification_type, "invite");
  const client = anonClient();
  const verified = await client.auth.verifyOtp({ type: "invite", token_hash: data.properties!.hashed_token });
  assert.ifError(verified.error);
  assert.equal(verified.data.user?.id, data.user!.id, "the link signs in exactly the invited account");
  assert.ifError((await client.auth.updateUser({ password: randomBytes(18).toString("base64url") })).error);
  const reused = await anonClient().auth.verifyOtp({ type: "invite", token_hash: data.properties!.hashed_token });
  assert.ok(reused.error, "the link works once");
});

test("invite refusal: inviting an email that already has an account does not produce a sign-in link", async () => {
  const { data } = await service.auth.admin.getUserById(ids.newcomer2);
  const { error } = await service.auth.admin.generateLink({ type: "invite", email: data.user!.email!, options: { redirectTo: "http://localhost:3000/auth/confirm" } });
  assert.ok(error, "Supabase refuses an invite for an existing account - the action turns this into a refusal, never a magic link");
});
