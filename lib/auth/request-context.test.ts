/**
 * Performance Pass B: unit tests for lib/auth/request-context.ts - the
 * request-scoped user + membership resolution. Fake Supabase client, no
 * network. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/auth/request-context.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrganizationMembership } from "./organization";

const require = createRequire(import.meta.url);
const { resolveRequestMembership, sessionUserIdHint }: typeof import("./request-context") = require("./request-context.ts");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const membershipFor: Record<string, OrganizationMembership> = {
  [USER_A]: { organizationId: ORG_A, organizationName: "Org A", role: "owner", paymentStatus: "active", vertical: "contractor" },
  [USER_B]: { organizationId: ORG_B, organizationName: "Org B", role: "member", paymentStatus: "active", vertical: "contractor" },
};

function jwt(sub: string | null): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(sub === null ? { role: "authenticated" } : { sub, role: "authenticated" })}.signature`;
}

type Scenario = { accessToken?: string | null; verifiedUserId: string | null; getUserDelayMs?: number };

function fakeClient(scenario: Scenario) {
  const events: string[] = [];
  const client = {
    auth: {
      getSession: async () => {
        events.push("getSession");
        return { data: { session: scenario.accessToken ? { access_token: scenario.accessToken } : null }, error: null };
      },
      getUser: async () => {
        events.push("getUser:start");
        await new Promise((resolve) => setTimeout(resolve, scenario.getUserDelayMs ?? 0));
        events.push("getUser:end");
        return scenario.verifiedUserId ? { data: { user: { id: scenario.verifiedUserId, email: "x@example.com" } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
  const lookups: string[] = [];
  const lookupMembership = async (_supabase: SupabaseClient, userId: string) => {
    lookups.push(userId);
    events.push(`lookup:${userId}`);
    return membershipFor[userId] ?? null;
  };
  return { client: client as unknown as SupabaseClient, lookupMembership, lookups, events };
}

test("logged out: no session and no verified user - no user, no membership, and no membership query at all", async () => {
  const fake = fakeClient({ accessToken: null, verifiedUserId: null });
  assert.deepEqual(await resolveRequestMembership(fake.client, { lookupMembership: fake.lookupMembership }), { user: null, membership: null });
  assert.deepEqual(fake.lookups, []);
});

test("authenticated member: the verified user and their own organization, with exactly one membership query", async () => {
  const fake = fakeClient({ accessToken: jwt(USER_A), verifiedUserId: USER_A });
  const result = await resolveRequestMembership(fake.client, { lookupMembership: fake.lookupMembership });
  assert.equal(result.user?.id, USER_A);
  assert.equal(result.membership?.organizationId, ORG_A);
  assert.deepEqual(fake.lookups, [USER_A]);
});

test("authenticated user without a membership: user present, membership null (the caller redirects to /onboarding)", async () => {
  const noOrgUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const fake = fakeClient({ accessToken: jwt(noOrgUser), verifiedUserId: noOrgUser });
  const result = await resolveRequestMembership(fake.client, { lookupMembership: fake.lookupMembership });
  assert.equal(result.user?.id, noOrgUser);
  assert.equal(result.membership, null);
});

test("organization isolation: a cookie naming user B but verified as user A never yields org B - the hint is discarded and A's own membership is re-read", async () => {
  const fake = fakeClient({ accessToken: jwt(USER_B), verifiedUserId: USER_A });
  const result = await resolveRequestMembership(fake.client, { lookupMembership: fake.lookupMembership });
  assert.equal(result.user?.id, USER_A);
  assert.equal(result.membership?.organizationId, ORG_A, "must be the verified user's organization, never the cookie's");
  assert.deepEqual(fake.lookups, [USER_B, USER_A], "the hinted result was fetched but thrown away");
});

test("revoked or invalid session: a cookie is present but getUser verifies nobody - no user and no membership, even though the hinted query found one", async () => {
  const fake = fakeClient({ accessToken: jwt(USER_A), verifiedUserId: null });
  assert.deepEqual(await resolveRequestMembership(fake.client, { lookupMembership: fake.lookupMembership }), { user: null, membership: null });
});

test("a malformed or sub-less token gives no hint - the membership is resolved from the verified user, sequentially", async () => {
  for (const token of ["not-a-jwt", "a.%%%.c", jwt(null)]) {
    const fake = fakeClient({ accessToken: token, verifiedUserId: USER_A });
    const result = await resolveRequestMembership(fake.client, { lookupMembership: fake.lookupMembership });
    assert.equal(result.membership?.organizationId, ORG_A, token);
    assert.deepEqual(fake.lookups, [USER_A], token);
    assert.ok(fake.events.indexOf(`lookup:${USER_A}`) > fake.events.indexOf("getUser:end"), "without a hint the lookup waits for verification");
  }
});

test("the speed-up: with a valid cookie the membership query starts before getUser has finished", async () => {
  const fake = fakeClient({ accessToken: jwt(USER_A), verifiedUserId: USER_A, getUserDelayMs: 20 });
  await resolveRequestMembership(fake.client, { lookupMembership: fake.lookupMembership });
  assert.ok(fake.events.indexOf(`lookup:${USER_A}`) < fake.events.indexOf("getUser:end"), fake.events.join(" -> "));
});

test("sessionUserIdHint never throws and returns only a string sub", async () => {
  const withSession = (session: unknown) => ({ auth: { getSession: async () => ({ data: { session } }) } }) as unknown as SupabaseClient;
  assert.equal(await sessionUserIdHint(withSession({ access_token: jwt(USER_A) })), USER_A);
  assert.equal(await sessionUserIdHint(withSession(null)), null);
  assert.equal(await sessionUserIdHint(withSession({ access_token: "x" })), null);
  assert.equal(await sessionUserIdHint({ auth: { getSession: async () => { throw new Error("boom"); } } } as unknown as SupabaseClient), null);
});

test("structural: request-scoped only - React.cache (per request), no module-level state, and the user always comes from getUser", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/auth/request-context.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(source, /import \{ cache \} from "react";/);
  assert.match(source, /export const getRequestSupabase = cache\(createClient\);/);
  assert.match(source, /export const getRequestMembership = cache\(async/);
  assert.doesNotMatch(source, /unstable_cache|"use cache"|new Map\(|globalThis|^let /m, "no cross-request cache or module state");
  assert.match(source, /const user = userResult\.data\.user \?\? null;\n\s*if \(!user\) return \{ user: null, membership: null \};/);
  assert.match(source, /const membership = hint === user\.id \? hinted : await lookup\(supabase, user\.id\);/);
});
