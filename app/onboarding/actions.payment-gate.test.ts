/**
 * Structural/wiring tests for Payment Gate V1's server-side enforcement
 * points. startCheckout() and app/(app)/layout.tsx both call
 * createClient() from lib/supabase/server.ts, which reads cookies() from
 * next/headers - exactly the same "outside a request scope" limitation
 * already documented in lib/leads/capture.integration.test.ts and
 * app/(auth)/signup/actions.notification.test.ts, so their Supabase-
 * dependent branches can't be exercised end-to-end from a bare node:test
 * script. These tests instead verify, against the real source, that:
 *
 *  (a) startCheckout never accepts an organization id from form data or
 *      any other client-supplied input - only from getUserOrganization(session);
 *  (b) app/(app)/layout.tsx actually enforces paymentStatus === 'active'
 *      before granting access, not just after resolving membership.
 *
 * The database-level enforcement (the guard trigger that makes client-side
 * tampering actually impossible even if this wiring were somehow bypassed)
 * is verified live, against a real Supabase project, in
 * app/api/webhooks/stripe/route.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/onboarding/actions.payment-gate.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/onboarding/actions.ts"), "utf8");
const LAYOUT_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(app)/layout.tsx"), "utf8");
const CHECKOUT_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/billing/checkout.ts"), "utf8");

test("1. startCheckout resolves the organization id from getUserOrganization, not from formData", () => {
  const fnMatch = ACTIONS_SOURCE.match(/export async function startCheckout[\s\S]*?\n}\n/);
  assert.ok(fnMatch, "expected to find the startCheckout function");
  const body = fnMatch![0];
  assert.match(body, /getUserOrganization\(supabase, user\.id\)/);
  assert.match(body, /createOrganizationCheckoutSession\(membership\.organizationId\)/);
  // The only formData read in this function must be the function's own
  // unused _formData parameter, never a field pulled out of it (e.g. an
  // organizationId a browser could supply).
  assert.doesNotMatch(body, /formData\.get\(/);
});

test("2. createOrganizationCheckoutSession stamps organization_id into both client_reference_id and metadata - never trusting a value the browser could set post-creation", () => {
  assert.match(CHECKOUT_SOURCE, /client_reference_id:\s*organizationId/);
  assert.match(CHECKOUT_SOURCE, /metadata:\s*\{\s*organization_id:\s*organizationId\s*\}/);
});

test("3. startCheckout refuses to start a second checkout once the organization is already active", () => {
  const fnMatch = ACTIONS_SOURCE.match(/export async function startCheckout[\s\S]*?\n}\n/);
  const body = fnMatch![0];
  assert.match(body, /membership\.paymentStatus === "active"/);
});

test("4. app/(app)/layout.tsx redirects to /onboarding when paymentStatus is not 'active'", () => {
  assert.match(LAYOUT_SOURCE, /membership\.paymentStatus !== "active"/);
  const guardIndex = LAYOUT_SOURCE.indexOf('membership.paymentStatus !== "active"');
  const redirectAfter = LAYOUT_SOURCE.indexOf('redirect("/onboarding")', guardIndex);
  assert.ok(guardIndex !== -1 && redirectAfter !== -1 && redirectAfter > guardIndex, "an unpaid organization must be redirected, not merely checked");
});

test("5. app/(app)/layout.tsx checks paymentStatus before rendering the CRM shell (before the sidebar/main content)", () => {
  const guardIndex = LAYOUT_SOURCE.indexOf('membership.paymentStatus !== "active"');
  const shellIndex = LAYOUT_SOURCE.indexOf("<Sidebar");
  assert.ok(guardIndex !== -1 && shellIndex !== -1 && guardIndex < shellIndex);
});
