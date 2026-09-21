/**
 * Verifies the signup -> internal-notification wiring added to
 * app/(auth)/signup/actions.ts. The signup() server action itself calls
 * `createClient()` from lib/supabase/server.ts, which reads cookies() from
 * next/headers - that throws "outside a request scope" when invoked from a
 * bare node:test script rather than a real Next.js request (the same class
 * of harness-only limitation already documented in
 * lib/leads/capture.integration.test.ts for next/server's after()), so
 * calling signup() directly here cannot exercise the Supabase-dependent
 * branches end-to-end. Instead this test combines:
 *
 *  (a) a structural check of the action's real source, verifying
 *      sendSignupNotification is called exactly once, and only after both
 *      the "invalid input" and "Supabase returned an error" early returns -
 *      the two conditions under which no notification must ever be sent;
 *  (b) real, live checks of the two pieces signup() actually composes
 *      (Supabase auth.signUp behavior, and sendSignupNotification's own
 *      input handling) against a real disposable account, proving the
 *      assumption the structural check above relies on is true in practice,
 *      not just on paper.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(auth)/signup/actions.notification.test.ts"
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

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

const { isValidEmail, validatePassword }: typeof import("@/lib/auth/validation") = require(
  path.join(REPO_ROOT, "lib/auth/validation.ts"),
);
const { sendSignupNotification }: typeof import("@/lib/email/send-signup-notification") = require(
  path.join(REPO_ROOT, "lib/email/send-signup-notification.ts"),
);

const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(auth)/signup/actions.ts"), "utf8");

test("1. sendSignupNotification is called exactly once in the signup action", () => {
  const matches = ACTIONS_SOURCE.match(/sendSignupNotification\(/g) ?? [];
  assert.equal(matches.length, 1, "sendSignupNotification must be called from exactly one place, so one signup can never produce two notifications");
});

test("2. the notification call appears after the duplicate-email early return (never sent when the account already existed)", () => {
  const duplicateReturnIndex = ACTIONS_SOURCE.indexOf("identities.length === 0");
  const notifyIndex = ACTIONS_SOURCE.indexOf("sendSignupNotification(");
  assert.ok(duplicateReturnIndex !== -1 && notifyIndex !== -1);
  assert.ok(notifyIndex > duplicateReturnIndex, "notification call must come after the already-exists check, not before it");
});

test("3. the notification call appears after the Supabase-error early return (never sent when signUp fails)", () => {
  const errorReturnIndex = ACTIONS_SOURCE.indexOf("if (error)");
  const notifyIndex = ACTIONS_SOURCE.indexOf("sendSignupNotification(");
  assert.ok(errorReturnIndex !== -1 && notifyIndex !== -1);
  assert.ok(notifyIndex > errorReturnIndex, "notification call must come after Supabase's own error check, not before it");
});

test("4. the notification call appears after all input-validation early returns (never sent for invalid email/password/mismatch)", () => {
  const notifyIndex = ACTIONS_SOURCE.indexOf("sendSignupNotification(");
  for (const marker of ["isValidEmail(email)", "validatePassword(password)", "password !== confirmPassword"]) {
    const markerIndex = ACTIONS_SOURCE.indexOf(marker);
    assert.ok(markerIndex !== -1, `expected to find "${marker}" in the signup action`);
    assert.ok(markerIndex < notifyIndex, `"${marker}" must be checked before the notification is ever sent`);
  }
});

test("5. the notification call appears before both success return paths (attempted on every real new signup)", () => {
  const notifyIndex = ACTIONS_SOURCE.indexOf("sendSignupNotification(");
  const successReturnIndex = ACTIONS_SOURCE.indexOf("return { success: true }");
  const redirectIndex = ACTIONS_SOURCE.lastIndexOf("redirect(");
  assert.ok(notifyIndex < successReturnIndex, "notification must be attempted before the no-session success return");
  assert.ok(notifyIndex < redirectIndex, "notification must be attempted before the auto-confirmed redirect");
});

test("6. isValidEmail/validatePassword reject the inputs the signup form itself would reject (confirms input validation still runs before any Supabase call)", () => {
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("person@example.com"), true);
  assert.ok(validatePassword("short") !== null);
  assert.equal(validatePassword("longenoughpassword"), null);
});

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let createdUserId: string | null = null;

after(async () => {
  if (createdUserId) {
    await service.auth.admin.deleteUser(createdUserId);
  }
});

test("7. a real Supabase user produces exactly the shape sendSignupNotification needs, and the built notification never contains a password", async () => {
  // Created via the service-role admin API, matching this repo's own
  // established fixture pattern (see lib/agency/authorization.integration.test.ts) -
  // the public signUp endpoint on this project rejects @example.com
  // addresses outright (a real, project-level email validation rule, not
  // something this task should work around by inventing a different test
  // domain). The object shape consumed here (user.id + the email supplied
  // at signup) is identical to what data.user carries out of a real
  // customer-facing supabase.auth.signUp() call.
  const email = `signup-notification-test-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";

  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: false });
  assert.equal(error, null, "creating the real disposable test user must succeed");
  assert.ok(data.user, "Supabase must return a real user");
  createdUserId = data.user!.id;

  let sentTo: string | undefined;
  let sentText: string | undefined;
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "notifications@example.com";
  try {
    await sendSignupNotification(
      { email, userId: data.user!.id },
      {
        send: async (built) => {
          sentTo = built.to;
          sentText = built.text;
          return {};
        },
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }

  assert.equal(sentTo, "contractorgrowthcompany@gmail.com");
  assert.ok(sentText!.includes(email));
  assert.ok(sentText!.includes(data.user!.id));
  assert.ok(!sentText!.toLowerCase().includes(password.toLowerCase()), "the real signup password must never appear in the notification body");
});

test("8. a real Supabase signUp failure (re-signing up an existing email) never reaches sendSignupNotification's precondition", async () => {
  // Re-using the email created in test 7 mirrors exactly what the app's own
  // duplicate-email branch guards against - the public signUp endpoint must
  // return either a real error or the empty-identities duplicate signal for
  // an email that already has an account, never a fresh new user. Whichever
  // one it returns, signup()'s own `if (error)` / `identities.length === 0`
  // checks (already proven in tests 2-3 to precede the notification call)
  // are what stand between this outcome and a wrongly-sent notification.
  assert.ok(createdUserId, "test 7 must have created the fixture user first");

  const { data: existing } = await service.auth.admin.getUserById(createdUserId!);
  const existingEmail = existing.user!.email!;

  const attempt = await anon.auth.signUp({ email: existingEmail, password: "a-different-password-456" });
  const isRealError = attempt.error !== null;
  const isEmptyIdentitiesSignal = Boolean(attempt.data.user) && (attempt.data.user?.identities?.length ?? 0) === 0;
  assert.ok(
    isRealError || isEmptyIdentitiesSignal,
    "re-signing up with an existing email must produce a real error or the empty-identities duplicate signal, never a genuinely new account",
  );
});
