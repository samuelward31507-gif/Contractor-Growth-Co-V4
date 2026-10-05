/**
 * Sign-in surface - structural guards for the Cinder -> Trackpr redesign of
 * /login (and the shell it shares with /signup, /forgot-password and
 * /auth/reset-password). The redesign is presentation only; these tests pin
 * that the forms still post to the same server actions with the same
 * fields, that the post-sign-in redirect and middleware are untouched, and
 * that the surface carries Cinder/Trackpr - never Contractor Growth Co.
 *
 * No component-rendering infrastructure exists in this repo, so - as with
 * every other "renders" claim in this suite - this reads the real source.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(auth)/auth-surface.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));

const LAYOUT = read("app/(auth)/layout.tsx");
const UI = read("app/(auth)/_components/auth-ui.tsx");
const PASSWORD = read("app/(auth)/_components/password-input.tsx");
const LOGIN_PAGE = read("app/(auth)/login/page.tsx");
const LOGIN_FORM = read("app/(auth)/login/login-form.tsx");
const SIGNUP_FORM = read("app/(auth)/signup/signup-form.tsx");
const FORGOT_FORM = read("app/(auth)/forgot-password/forgot-password-form.tsx");
const RESET_FORM = read("app/auth/reset-password/reset-password-form.tsx");
const SURFACE = [
  "app/(auth)/layout.tsx",
  "app/(auth)/_components/auth-ui.tsx",
  "app/(auth)/_components/password-input.tsx",
  "app/(auth)/login/page.tsx",
  "app/(auth)/login/login-form.tsx",
  "app/(auth)/signup/page.tsx",
  "app/(auth)/signup/signup-form.tsx",
  "app/(auth)/forgot-password/page.tsx",
  "app/(auth)/forgot-password/forgot-password-form.tsx",
  "app/auth/reset-password/page.tsx",
  "app/auth/reset-password/reset-password-form.tsx",
];

test("1. /login renders: the page renders the login form inside the shared sign-in shell, with its own title", () => {
  assert.match(LOGIN_PAGE, /export default async function LoginPage/);
  assert.match(LOGIN_PAGE, /<LoginForm\b/);
  assert.match(LOGIN_PAGE, /title: "Sign in · Trackpr"/);
  assert.match(LOGIN_PAGE, /params\.error === "confirmation_failed"/, "the expired-confirmation notice is kept");
  assert.match(LAYOUT, /export default function AuthLayout\(\{ children \}/);
  assert.match(read("app/auth/reset-password/page.tsx"), /import AuthLayout from "@\/app\/\(auth\)\/layout";/, "reset-password still reuses the same shell");
});

test("2. branding: Cinder is the company, Trackpr the product, sign-in the task", () => {
  assert.match(LAYOUT, /<CinderLogo tone="light" variant="full"/, "the real Cinder logo, not a second one");
  assert.match(LAYOUT, /import \{ CinderLogo, CinderMark \} from "@\/app\/\(cinder\)\/_components\/logo";/);
  assert.match(LAYOUT, /Trackpr is a product of Cinder Revenue Company/);
  assert.match(LAYOUT, /© \{new Date\(\)\.getFullYear\(\)\} Cinder Revenue Company/);
  assert.match(UI, /<TrackprTile \/>\s*Trackpr/, "every panel opens with the Trackpr mark");
  assert.match(LOGIN_FORM, /<AuthHeader title="Welcome back\." subtitle="Sign in to your revenue operating system\." \/>/);
});

test("3. no Contractor Growth Co. and no contractor-specific language anywhere on the sign-in surface", () => {
  for (const file of SURFACE) {
    assert.doesNotMatch(read(file), /Contractor Growth|contractor|contracting|\btrades?\b/i, file);
  }
});

test("4. the login form still submits through the existing auth flow, with the same fields", () => {
  assert.match(LOGIN_FORM, /import \{ login, type LoginState \} from "\.\/actions";/);
  assert.match(LOGIN_FORM, /useActionState\(login, initialState\)/);
  assert.match(LOGIN_FORM, /<form action=\{formAction\}/);
  assert.match(LOGIN_FORM, /id="email"\s+name="email"\s+type="email"/);
  assert.match(LOGIN_FORM, /autoComplete="email"/);
  assert.match(LOGIN_FORM, /<PasswordInput id="password" name="password" autoComplete="current-password"/);
  assert.match(LOGIN_FORM, /<AuthSubmit pending=\{isPending\} idleLabel="Sign in" pendingLabel="Signing in…" \/>/);
  // The password field submits its own name; the visibility toggle is a plain button, never submitted.
  assert.match(PASSWORD, /name=\{name\}\s+type=\{visible \? "text" : "password"\}/);
  assert.match(PASSWORD, /<button\s+type="button"/);
  assert.match(PASSWORD, /aria-label=\{visible \? "Hide password" : "Show password"\}/);
  // The submit button keeps its pending state.
  assert.match(UI, /<button type="submit" disabled=\{pending\} aria-busy=\{pending \|\| undefined\}/);
});

test("5. the redirect after sign-in and the middleware's auth routing are unchanged", () => {
  const actions = read("app/(auth)/login/actions.ts");
  assert.match(actions, /supabase\.auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.match(actions, /redirect\(membership \? "\/today" : "\/onboarding"\);/);
  const middleware = read("lib/supabase/middleware.ts");
  assert.match(middleware, /const AUTH_PATHS = new Set\(\["\/login", "\/signup", "\/forgot-password"\]\);/);
  assert.match(middleware, /url\.pathname = "\/login";/);
});

test("6. signup, forgot-password and reset-password keep their actions and fields", () => {
  assert.match(SIGNUP_FORM, /useActionState\(signup, initialState\)/);
  assert.match(SIGNUP_FORM, /<PasswordInput id="password" name="password" autoComplete="new-password" minLength=\{8\}/);
  assert.match(SIGNUP_FORM, /<PasswordInput id="confirmPassword" name="confirmPassword" autoComplete="new-password" minLength=\{8\}/);
  assert.match(SIGNUP_FORM, /id="agreeToTerms" name="agreeToTerms" type="checkbox" value="true" required/);
  assert.match(FORGOT_FORM, /useActionState\(requestPasswordReset, initialState\)/);
  assert.match(FORGOT_FORM, /id="email"\s+name="email"\s+type="email"/);
  assert.match(RESET_FORM, /useActionState\(resetPassword, initialState\)/);
  assert.match(RESET_FORM, /<PasswordInput id="password" name="password" autoComplete="new-password" minLength=\{8\}/);
  assert.match(RESET_FORM, /<PasswordInput id="confirmPassword" name="confirmPassword" autoComplete="new-password" minLength=\{8\}/);
  // Onboarding still uses the original auth-form tokens, which this redesign leaves alone.
  assert.ok(exists("lib/ui/auth-form.ts"));
});

test("7. sign-in links: password reset and the existing signup route; no /trackpr/login", () => {
  assert.match(LOGIN_FORM, /href="\/forgot-password"/);
  assert.match(LOGIN_FORM, /href="\/signup"[\s\S]*?Create an account/);
  assert.ok(!exists("app/(cinder)/trackpr/login"));
  assert.ok(!exists("app/trackpr/login"));
});
