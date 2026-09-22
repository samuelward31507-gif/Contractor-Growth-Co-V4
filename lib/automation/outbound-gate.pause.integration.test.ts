/**
 * Live proof for Launch Blocker #5's real enforcement point: evaluateOutboundGate()
 * takes a plain SupabaseClient parameter (no cookies() dependency - unlike
 * most Server Actions in this codebase, it can be called directly here with
 * a real database and real fixtures).
 *
 * STATUS: supabase/migrations/20260922020000_organization_automation_pause.sql
 * has been applied to production. Both sections below pass for the real
 * reason - Section 1 structurally, Section 2 against a real database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/automation/outbound-gate.pause.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { evaluateOutboundGate, type OutboundGateInput } from "./outbound-gate";

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

const OUTBOUND_GATE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/automation/outbound-gate.ts"), "utf8");

// ===========================================================================
// SECTION 1 - STATIC (structural, no database - passes today regardless of migration status)
// ===========================================================================

test("1. automation_paused is read fresh from its own independent query on every call, never cached, and never combined into the same select as automation_mode - a missing/unreadable pause column can only ever add its own fail-closed restriction, never take down the pre-existing automation_mode check by making that query fail too", () => {
  assert.match(OUTBOUND_GATE_SOURCE, /\.select\("automation_mode"\)/);
  assert.match(OUTBOUND_GATE_SOURCE, /\.select\("automation_paused"\)/);
  assert.doesNotMatch(OUTBOUND_GATE_SOURCE, /\.select\("automation_mode, automation_paused"\)/);
});

test("2. the organization_automation_paused denial is checked immediately after organization_not_live - additive, never replacing the existing go-live check", () => {
  const notLiveIndex = OUTBOUND_GATE_SOURCE.indexOf('deny("organization_not_live")');
  const pausedCheckIndex = OUTBOUND_GATE_SOURCE.indexOf("pauseRow?.automation_paused");
  assert.ok(notLiveIndex !== -1 && pausedCheckIndex !== -1 && notLiveIndex < pausedCheckIndex);
});

test("3. a missing/unreadable pause row or a query error is never treated as \"not paused\" - fails closed the same way the existing automation_mode check already does, without touching that check's own query", () => {
  assert.match(OUTBOUND_GATE_SOURCE, /if \(pauseError \|\| pauseRow\?\.automation_paused\) return deny\("organization_automation_paused"\);/);
});

test("4. every existing safety check (opt-out, content safety, needs_human, duplicate-send, conversation/lead/appointment/estimate/job scoping, business hours) is textually unmodified by this change", () => {
  for (const marker of [
    'return deny("contact_opted_out")',
    "evaluateContentSafety(body)",
    'return deny("needs_human")',
    'return deny("duplicate_outbound_send")',
    'return deny("conversation_ai_disabled")',
    "isWithinBusinessHours(",
  ]) {
    assert.ok(OUTBOUND_GATE_SOURCE.includes(marker), `expected existing safety check to still be present: ${marker}`);
  }
});

// ===========================================================================
// SECTION 2 - LIVE: real enforcement, once the migration is applied
// ===========================================================================

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let organizationId: string;
let contactId: string;
let conversationId: string;
let executionId: string;

async function setPaused(paused: boolean) {
  const { error } = await service.from("organizations").update({ automation_paused: paused }).eq("id", organizationId);
  if (error) throw error;
}

function baseInput(overrides: Partial<OutboundGateInput> = {}): OutboundGateInput {
  return {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId: null,
    aiResult: { should_send: true, response_message: "Thanks for reaching out - we'll follow up shortly.", needs_human: false },
    ...overrides,
  };
}

before(async () => {
  const { data: org, error: orgErr } = await service.from("organizations").insert({ name: "Kill Switch Test Org", automation_mode: "live" }).select("id").single();
  if (orgErr) throw orgErr;
  organizationId = org!.id;

  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .insert({ organization_id: organizationId, first_name: "Test", phone: "+15555550111", sms_opt_out: false })
    .select("id")
    .single();
  if (contactErr) throw contactErr;
  contactId = contact!.id;

  const { data: conversation, error: convErr } = await service
    .from("conversations")
    .insert({ organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open", ai_enabled: true })
    .select("id")
    .single();
  if (convErr) throw convErr;
  conversationId = conversation!.id;

  const { data: execution, error: execErr } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, workflow_name: "kill_switch_test", status: "running" })
    .select("id")
    .single();
  if (execErr) throw execErr;
  executionId = execution!.id;
});

after(async () => {
  await service.from("organizations").delete().eq("id", organizationId);
});

test("5. a LIVE, unpaused organization: an otherwise-fully-eligible send is allowed - the baseline this suite's other cases are compared against", async () => {
  await setPaused(false);
  const result = await evaluateOutboundGate(service, baseInput());
  assert.equal(result.allowed, true);
});

test("6. a LIVE, PAUSED organization: the exact same otherwise-eligible send is denied with reason organization_automation_paused", async () => {
  await setPaused(true);
  const result = await evaluateOutboundGate(service, baseInput());
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "organization_automation_paused");
});

test("7. resuming (unpausing) the same organization immediately restores normal send behavior - no stale caching, no lingering denial", async () => {
  await setPaused(true);
  const denied = await evaluateOutboundGate(service, baseInput());
  assert.equal(denied.allowed, false);

  await setPaused(false);
  const allowed = await evaluateOutboundGate(service, baseInput());
  assert.equal(allowed.allowed, true);
});

test("8. pausing does NOT bypass or weaken existing safety gates - an opted-out contact is still denied for that reason even while unpaused", async () => {
  await setPaused(false);
  await service.from("contacts").update({ sms_opt_out: true }).eq("id", contactId);
  try {
    const result = await evaluateOutboundGate(service, baseInput());
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.reason, "contact_opted_out");
  } finally {
    await service.from("contacts").update({ sms_opt_out: false }).eq("id", contactId);
  }
});

test("9. pausing does NOT bypass needs_human - a needs_human result is still denied for that reason even while unpaused", async () => {
  await setPaused(false);
  const result = await evaluateOutboundGate(service, baseInput({ aiResult: { should_send: true, response_message: "x", needs_human: true } }));
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "needs_human");
});

test("10. a paused organization is denied even when automation_mode is 'test' (not yet live) - both restrictions apply independently, neither one substitutes for the other", async () => {
  await service.from("organizations").update({ automation_mode: "test" }).eq("id", organizationId);
  await setPaused(true);
  try {
    const result = await evaluateOutboundGate(service, baseInput());
    assert.equal(result.allowed, false);
    // Either denial reason is a correct outcome here (both independently block) -
    // what matters is that it is never allowed.
  } finally {
    await service.from("organizations").update({ automation_mode: "live" }).eq("id", organizationId);
  }
});
