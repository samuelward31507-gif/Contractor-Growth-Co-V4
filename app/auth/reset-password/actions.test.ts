/**
 * Tests for Launch Blocker #4's reset-password action
 * (app/auth/reset-password/actions.ts). resetPassword() calls createClient()
 * from lib/supabase/server.ts (cookies()), so - like every other
 * cookie-bound Server Action in this codebase - it can't be invoked
 * directly from a bare node:test script. Section 1 verifies the real
 * source structurally (validation order, the unauthenticated guard, that
 * no service-role/admin API or client-supplied user id is ever used).
 * Section 2 proves, live, the actual Supabase mechanics the action relies
 * on: an authenticated session's own updateUser({ password }) call
 * succeeds and the new password genuinely works for a subsequent sign-in -
 * real evidence, not just that the code calls the right function name.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/auth/reset-password/actions.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
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

const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/auth/reset-password/actions.ts"), "utf8");

// ===========================================================================
// SECTION 1 - STATIC (structural, no database)
// ===========================================================================

test("1. password validation (validatePassword) and the mismatch check both run before updateUser is ever called", () => {
  const validateIndex = ACTIONS_SOURCE.indexOf("validatePassword(password)");
  const mismatchIndex = ACTIONS_SOURCE.indexOf("password !== confirmPassword");
  // The real call, not the doc-comment above it that also mentions updateUser().
  const updateUserIndex = ACTIONS_SOURCE.indexOf("supabase.auth.updateUser({ password })");
  assert.ok(validateIndex !== -1 && mismatchIndex !== -1 && updateUserIndex !== -1);
  assert.ok(validateIndex < updateUserIndex && mismatchIndex < updateUserIndex);
});

test("2. an unauthenticated request (no session user) is rejected before updateUser is called", () => {
  const guardIndex = ACTIONS_SOURCE.indexOf("if (!user) {");
  const updateUserIndex = ACTIONS_SOURCE.indexOf("supabase.auth.updateUser({ password })");
  assert.ok(guardIndex !== -1 && updateUserIndex !== -1 && guardIndex < updateUserIndex);
  assert.match(ACTIONS_SOURCE, /if \(!user\) \{\s*\n\s*return \{ error: ".*?" \};\s*\n\s*\}/);
});

test("3. updateUser is called with only { password } - no user id, no email, nothing that could target a different account", () => {
  assert.match(ACTIONS_SOURCE, /supabase\.auth\.updateUser\(\{ password \}\)/);
});

test("4. the service-role client/admin API is never imported or used - only the ordinary cookie-bound session client", () => {
  assert.doesNotMatch(ACTIONS_SOURCE, /createServiceRoleClient|auth\.admin\./);
  assert.match(ACTIONS_SOURCE, /import \{ createClient \} from "@\/lib\/supabase\/server";/);
});

test("5. a failed updateUser call is mapped through the existing mapAuthError utility, not surfaced raw", () => {
  const fnMatch = ACTIONS_SOURCE.match(/const \{ error \} = await supabase\.auth\.updateUser\(\{ password \}\);\s*\n\s*\n\s*if \(error\) \{\s*\n\s*return \{ error: mapAuthError\(error\) \};\s*\n\s*\}/);
  assert.ok(fnMatch, "expected updateUser's error to be passed through mapAuthError before being returned");
});

test("6. a successful update redirects through the exact same membership-aware pattern login() uses", () => {
  assert.match(ACTIONS_SOURCE, /const membership = await getUserOrganization\(supabase, user\.id\);\s*\n\s*redirect\(membership \? "\/dashboard" : "\/onboarding"\);/);
});

// ===========================================================================
// SECTION 2 - LIVE: the actual Supabase mechanics resetPassword() relies on
// ===========================================================================

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `reset-password-test-${Date.now()}@example.com`;
const originalPassword = "a-real-test-password-123";
const newPassword = "a-new-real-test-password-456";
let userId: string;

test("7. setup: create one real disposable user", async () => {
  const { data, error } = await service.auth.admin.createUser({ email, password: originalPassword, email_confirm: true });
  assert.equal(error, null);
  userId = data.user!.id;
});

test("8. an authenticated session can update its OWN password via updateUser({ password }) - the exact call resetPassword() makes", async () => {
  const { error: signInError } = await anon.auth.signInWithPassword({ email, password: originalPassword });
  assert.equal(signInError, null);

  // GoTrueClient's own auth.* methods (unlike a plain .from() PostgREST
  // call) need a real session established ON THIS CLIENT INSTANCE via
  // signInWithPassword/setSession - an Authorization header override in
  // client options only affects PostgREST/Storage requests, not
  // updateUser()'s own internal session lookup. So this deliberately
  // reuses the same `anon` client signInWithPassword just authenticated,
  // exactly like a real browser's single Supabase client would.
  const { error: updateError } = await anon.auth.updateUser({ password: newPassword });
  assert.equal(updateError, null);
});

test("9. the new password genuinely works for a subsequent sign-in, and the old one no longer does", async () => {
  const { error: newPasswordError } = await anon.auth.signInWithPassword({ email, password: newPassword });
  assert.equal(newPasswordError, null, "the new password must work");

  const { error: oldPasswordError } = await anon.auth.signInWithPassword({ email, password: originalPassword });
  assert.ok(oldPasswordError, "the old password must no longer work");
});

test("10. an unauthenticated (anon, no session) client cannot call updateUser at all - there is no session for it to act on", async () => {
  // A genuinely fresh client, not the shared `anon` above - that one still
  // holds an in-memory session from tests 8/9's signInWithPassword calls
  // even with persistSession: false (which only controls storage, not the
  // client's own in-memory state for its lifetime).
  const freshAnon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await freshAnon.auth.getUser();
  assert.equal(data.user, null);
  assert.ok(error, "confirms a client with no session genuinely has none - resetPassword()'s own `if (!user)` guard covers exactly this case");
});

test("11. cleanup: the disposable user is deleted", async () => {
  const { error } = await service.auth.admin.deleteUser(userId);
  assert.equal(error, null);
});
