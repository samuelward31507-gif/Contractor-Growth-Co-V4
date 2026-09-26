/**
 * Trackpr 2.0, Phase 4C (P2 #8): integration tests for the real POST()
 * handler of app/api/leads/capture/[token]/route.ts, focused specifically on
 * the new rate limit - lib/leads/capture.integration.test.ts already
 * thoroughly covers every other aspect of this route (contact dedup,
 * duplicate-submission window, organization isolation, lifecycle
 * attribution) by calling the underlying functions directly; this file
 * calls the real route handler itself, matching
 * app/api/webhooks/sms/inbound/route.integration.test.ts's own established
 * "call the real, unmodified POST()" pattern, since the rate limit lives
 * inline in the route rather than in an extracted, separately-testable
 * function.
 *
 * Deliberately placed under lib/leads/ rather than alongside the route
 * itself - Node's test runner does not reliably discover a test file placed
 * inside a `[token]` (bracketed) directory name.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/leads/capture-rate-limit.integration.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { NextRequest } = require("next/server");
const { POST }: typeof import("@/app/api/leads/capture/[token]/route") = require(path.join(REPO_ROOT, "app/api/leads/capture/[token]/route.ts"));

const service = createServiceRoleClient();

/**
 * emitLeadCreatedFollowupAsService's own n8n-dispatch call uses Next.js's
 * after(), which has no valid scope outside a real Next.js request - the
 * same documented test-harness limitation this codebase already tolerates
 * identically in app/(app)/jobs/actions.referral-lead.integration.test.ts's
 * callAction() and lib/automation/no-show-detection.integration.test.ts's
 * processNoShowDetectionTolerant(). By the time after() is reached, the
 * route's own real work (contact, lead, response status) has already
 * committed and already been returned, so this is never treated as a
 * product regression here.
 */
async function submit(token: string, body: Record<string, unknown>) {
  const request = new NextRequest(`http://localhost/api/leads/capture/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await POST(request, { params: Promise.resolve({ token }) });
  } catch (err) {
    if (err instanceof Error && err.message.includes("`after` was called outside a request scope")) {
      return new Response(JSON.stringify({ ok: true, tolerated: true }), { status: 201 });
    }
    throw err;
  }
}

test("P2 #8: legitimate, low-volume submissions are never blocked by the rate limit", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Lead Capture Rate Limit Test Org (Normal)" }).select("id, lead_intake_token").single();
  try {
    for (let i = 0; i < 5; i++) {
      const response = await submit(org!.lead_intake_token, { phone: `+1555700${1000 + i}`, first_name: `Normal${i}` });
      assert.equal(response.status, 201, `submission ${i} must succeed - 5 distinct leads is far below the flood threshold`);
    }
  } finally {
    await service.from("organizations").delete().eq("id", org!.id);
  }
});

test("P2 #8: exceeding the flood threshold is rejected with 429, without altering the existing per-contact duplicate-window semantics", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Lead Capture Rate Limit Test Org (Flood)" }).select("id, lead_intake_token").single();
  const orgId = org!.id as string;
  const token = org!.lead_intake_token as string;
  try {
    // Seed the organization with exactly the threshold's worth of recent,
    // distinct leads directly (bypassing the route, for test speed) - the
    // check counts real rows in the leads table, not requests, so this is a
    // faithful way to arrive at the boundary without 20 real HTTP round trips.
    for (let i = 0; i < 20; i++) {
      const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: `+1555701${1000 + i}` }).select("id").single();
      await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "new", temperature: "cold", source: "seed" });
    }

    const response = await submit(token, { phone: "+15557029999", first_name: "OneTooMany" });
    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.equal(payload.ok, false);

    // The rejected submission must never create a contact.
    const { data: blockedContact } = await service.from("contacts").select("id").eq("organization_id", orgId).eq("phone", "+15557029999").maybeSingle();
    assert.equal(blockedContact, null, "a request blocked by the rate limit must never create a contact");
  } finally {
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("P2 #8: the rate limit is scoped per-organization - a flood against one organization's token never blocks a different organization", async () => {
  const { data: floodedOrg } = await service.from("organizations").insert({ name: "Lead Capture Rate Limit Test Org (Isolation A)" }).select("id, lead_intake_token").single();
  const { data: quietOrg } = await service.from("organizations").insert({ name: "Lead Capture Rate Limit Test Org (Isolation B)" }).select("id, lead_intake_token").single();
  try {
    for (let i = 0; i < 20; i++) {
      const { data: contact } = await service.from("contacts").insert({ organization_id: floodedOrg!.id, phone: `+1555703${1000 + i}` }).select("id").single();
      await service.from("leads").insert({ organization_id: floodedOrg!.id, contact_id: contact!.id, status: "new", temperature: "cold", source: "seed" });
    }

    const blockedResponse = await submit(floodedOrg!.lead_intake_token, { phone: "+15557049999", first_name: "Blocked" });
    assert.equal(blockedResponse.status, 429);

    const okResponse = await submit(quietOrg!.lead_intake_token, { phone: "+15557059999", first_name: "StillFine" });
    assert.equal(okResponse.status, 201, "a different organization's own token must be completely unaffected by another organization's flood");
  } finally {
    await service.from("organizations").delete().eq("id", floodedOrg!.id);
    await service.from("organizations").delete().eq("id", quietOrg!.id);
  }
});
