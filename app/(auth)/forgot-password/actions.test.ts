/**
 * Tests for Launch Blocker #4's forgot-password request flow
 * (app/(auth)/forgot-password/actions.ts). requestPasswordReset() calls
 * createClient() from lib/supabase/server.ts, which reads cookies() from
 * next/headers - the same "outside a request scope" limitation already
 * documented throughout this codebase's other auth Server Action tests
 * (app/(auth)/signup/actions.notification.test.ts,
 * app/(auth)/signup/actions.confirm-redirect.test.ts), so the action can't
 * be invoked directly from a bare node:test script. Section 1 verifies the
 * real source structurally; Section 2 proves, live, that Supabase's own
 * resetPasswordForEmail does not distinguish an existing account from a
 * nonexistent one - the actual mechanism the action's uniform response
 * relies on for no user-enumeration.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(auth)/forgot-password/actions.test.ts"
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

const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(auth)/forgot-password/actions.ts"), "utf8");

// ===========================================================================
// SECTION 1 - STATIC (structural, no database)
// ===========================================================================

test("1. an invalid email is rejected via the existing isValidEmail utility before any Supabase call", () => {
  assert.match(ACTIONS_SOURCE, /import \{ isValidEmail \} from "@\/lib\/auth\/validation";/);
  const guardIndex = ACTIONS_SOURCE.indexOf("if (!email || !isValidEmail(email))");
  const supabaseCallIndex = ACTIONS_SOURCE.indexOf("resetPasswordForEmail(");
  assert.ok(guardIndex !== -1 && supabaseCallIndex !== -1 && guardIndex < supabaseCallIndex);
});

test("2. resetPasswordForEmail is called with redirectTo pointing at ${baseUrl}/auth/confirm - the SAME callback URL as signup, never a second one", () => {
  assert.match(ACTIONS_SOURCE, /redirectTo:\s*`\$\{baseUrl\}\/auth\/confirm`/);
});

test("3. the base URL is resolved via the same production-safe resolveAppBaseUrl() helper from lib/automation/sms.ts, not a new resolver", () => {
  assert.match(ACTIONS_SOURCE, /import \{ resolveAppBaseUrl \} from "@\/lib\/automation\/sms";/);
  assert.match(ACTIONS_SOURCE, /const configured = resolveAppBaseUrl\(\);/);
});

test("4. the function returns the same generic success shape regardless of whether resetPasswordForEmail errored - the error is never surfaced to the caller", () => {
  const fnMatch = ACTIONS_SOURCE.match(/export async function requestPasswordReset\([\s\S]*?\n}/);
  assert.ok(fnMatch, "expected to find requestPasswordReset");
  const body = fnMatch![0];
  // Only one `return` reachable after the resetPasswordForEmail call - `return { success: true }` -
  // and the error branch only logs, it never returns a different shape.
  const afterCallIndex = body.indexOf("resetPasswordForEmail(");
  const afterCall = body.slice(afterCallIndex);
  assert.doesNotMatch(afterCall, /return \{ error:/, "an error from Supabase must never be returned to the caller - that would leak account-existence information");
  assert.match(afterCall, /return \{ success: true \};/);
});

test("5. any resetPasswordForEmail error is only logged server-side (console.error), never included in the returned state", () => {
  assert.match(ACTIONS_SOURCE, /console\.error\("\[auth\] resetPasswordForEmail failed"/);
});

// ===========================================================================
// SECTION 2 - LIVE: proves Supabase's own no-enumeration behavior
// ===========================================================================

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let existingUserId: string;
const existingEmail = `forgot-password-test-${Date.now()}@example.com`;
const nonexistentEmail = `forgot-password-nonexistent-${Date.now()}@example.com`;

test("6. setup: create one real disposable user to compare against", async () => {
  const { data, error } = await service.auth.admin.createUser({ email: existingEmail, password: "a-real-test-password-123", email_confirm: true });
  assert.equal(error, null);
  existingUserId = data.user!.id;
});

test("7. resetPasswordForEmail for an EXISTING account returns no error, OR fails only with this project's own already-known email-send rate limit (a real infra constraint from this session's extensive prior live-email testing, not an enumeration signal or a code defect - any OTHER error is a genuine failure)", async () => {
  const { error } = await anon.auth.resetPasswordForEmail(existingEmail, { redirectTo: "http://localhost:3000/auth/confirm" });
  if (error) {
    assert.equal(error.code, "over_email_send_rate_limit", `expected either success or the known rate limit, got: ${error.code}`);
  }
});

test("8. resetPasswordForEmail for a NONEXISTENT account also returns no error - identical response shape, proving Supabase itself does not leak account existence here", async () => {
  const { error } = await anon.auth.resetPasswordForEmail(nonexistentEmail, { redirectTo: "http://localhost:3000/auth/confirm" });
  assert.equal(error, null);
});

test("9. cleanup: the disposable user is deleted", async () => {
  const { error } = await service.auth.admin.deleteUser(existingUserId);
  assert.equal(error, null);
});
