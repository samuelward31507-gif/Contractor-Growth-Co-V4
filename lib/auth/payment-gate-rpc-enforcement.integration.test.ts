/**
 * Evidence for the SECURITY DEFINER RPC gap closed by
 * supabase/migrations/20260921160000_payment_gate_rpc_enforcement.sql.
 *
 * IMPORTANT - READ BEFORE INTERPRETING RESULTS, same caveat as
 * lib/auth/payment-gate-rls.integration.test.ts: this migration has NOT
 * been applied anywhere (no disposable database was available - see the
 * accompanying report). Two different kinds of evidence are combined here,
 * clearly separated and labeled:
 *
 *  (a) STATIC tests (section 1) - read supabase/migrations/20260921160000_payment_gate_rpc_enforcement.sql
 *      and supabase/migrations/20260921150000_payment_gate_rls_enforcement.sql
 *      as text and assert structural properties: every target function's
 *      signature is byte-identical to the live, currently-deployed
 *      signature (so CREATE OR REPLACE truly replaces, never overloads),
 *      exactly one organization_payment_active() call was added per
 *      function, functions with a service_role branch have the new check
 *      nested inside `if not v_is_service_role`, functions without one
 *      never gained a v_is_service_role reference, and the first migration
 *      file was not touched. These do not prove runtime behavior - they
 *      prove the SQL is shaped the way the report claims.
 *
 *  (b) LIVE tests (section 2) - real minted Supabase Auth sessions calling
 *      four representative RPCs (merge_contacts, acknowledge_automation_incident,
 *      create_automation_event, start_workflow_execution) against the
 *      CURRENT, unmigrated database - i.e. today's already-deployed
 *      function bodies, which do not yet contain the payment check. These
 *      tests assert the DESIRED post-migration behavior and are EXPECTED
 *      TO FAIL for the "should be denied while unpaid" cases - a failure
 *      here is live, empirical proof the RPC bypass is real today, exactly
 *      mirroring how lib/auth/payment-gate-rls.integration.test.ts proved
 *      the table-level bypass. The "should already succeed" cases (paid
 *      org, and service_role regardless of payment_status) are expected to
 *      genuinely pass today, proving this change doesn't regress them.
 *      The remaining 8 RPCs are covered only by the static tests in
 *      section 1, not live - clearly a smaller evidence base, disclosed
 *      here rather than left implicit.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/auth/payment-gate-rpc-enforcement.integration.test.ts"
 */
import { test, before, after } from "node:test";
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

const RPC_MIGRATION_PATH = path.join(REPO_ROOT, "supabase/migrations/20260921160000_payment_gate_rpc_enforcement.sql");
const RLS_MIGRATION_PATH = path.join(REPO_ROOT, "supabase/migrations/20260921150000_payment_gate_rls_enforcement.sql");
const RPC_SOURCE = fs.readFileSync(RPC_MIGRATION_PATH, "utf8");
const RLS_SOURCE = fs.readFileSync(RLS_MIGRATION_PATH, "utf8");

function extractFunctionBody(source: string, functionName: string): string {
  const startPattern = new RegExp(`create or replace function public\\.${functionName}\\(`, "i");
  const startMatch = startPattern.exec(source);
  assert.ok(startMatch, `expected to find ${functionName} in the migration`);
  const startIndex = startMatch!.index;
  const nextFuncIndex = source.indexOf("\ncreate or replace function", startIndex + 1);
  return nextFuncIndex === -1 ? source.slice(startIndex) : source.slice(startIndex, nextFuncIndex);
}

const SERVICE_ROLE_AWARE = [
  "resolve_automation_incidents_by_fingerprint",
  "record_automation_incident_signal",
  "create_automation_event",
  "start_workflow_execution",
  "complete_workflow_execution",
  "fail_workflow_execution",
];

const ALWAYS_USER_ONLY = [
  "merge_contacts",
  "acknowledge_automation_incident",
  "resolve_automation_incident",
  "create_automation_audit_event",
  "create_organization_audit_event",
  "create_review_referral_audit_event",
];

const EXPECTED_SIGNATURES: Record<string, string> = {
  merge_contacts: "public.merge_contacts(p_organization_id uuid, p_source_contact_id uuid, p_target_contact_id uuid, p_reason text default null::text)",
  acknowledge_automation_incident: "public.acknowledge_automation_incident(p_incident_id uuid)",
  resolve_automation_incident: "public.resolve_automation_incident(p_incident_id uuid)",
  resolve_automation_incidents_by_fingerprint: "public.resolve_automation_incidents_by_fingerprint(p_organization_id uuid, p_fingerprints text[])",
  record_automation_incident_signal:
    "public.record_automation_incident_signal(p_organization_id uuid, p_category text, p_severity text, p_fingerprint text, p_title text, p_description text default null::text, p_automation_id text default null::text, p_workflow_execution_id uuid default null::uuid, p_metadata jsonb default '{}'::jsonb)",
  create_automation_event:
    "public.create_automation_event(p_event_type text, p_entity_type text, p_entity_id uuid, p_payload jsonb, p_idempotency_key text, p_organization_id uuid default null::uuid)",
  start_workflow_execution: "public.start_workflow_execution(p_automation_event_id uuid, p_workflow_name text, p_metadata jsonb, p_trigger_source text default 'event'::text)",
  complete_workflow_execution: "public.complete_workflow_execution(p_execution_id uuid, p_metadata jsonb)",
  fail_workflow_execution: "public.fail_workflow_execution(p_execution_id uuid, p_error_message text)",
  create_automation_audit_event:
    "public.create_automation_audit_event(p_organization_id uuid, p_action text, p_automation_id text, p_metadata jsonb default '{}'::jsonb, p_entity_id uuid default null::uuid)",
  create_organization_audit_event: "public.create_organization_audit_event(p_organization_id uuid, p_action text, p_metadata jsonb default '{}'::jsonb)",
  create_review_referral_audit_event:
    "public.create_review_referral_audit_event(p_organization_id uuid, p_action text, p_entity_type text, p_entity_id uuid, p_metadata jsonb default '{}'::jsonb)",
};

// ===========================================================================
// SECTION 1 - STATIC (structural, no database)
// ===========================================================================

test("1.1 the migration defines exactly the 12 target functions, no more, no fewer", () => {
  const matches = [...RPC_SOURCE.matchAll(/create or replace function public\.(\w+)\(/gi)].map((m) => m[1]);
  assert.deepEqual(new Set(matches), new Set(Object.keys(EXPECTED_SIGNATURES)));
});

for (const [name, expectedSignature] of Object.entries(EXPECTED_SIGNATURES)) {
  test(`1.2 ${name}: signature is byte-identical to the live, currently-deployed signature (CREATE OR REPLACE truly replaces, never overloads)`, () => {
    const body = extractFunctionBody(RPC_SOURCE, name);
    const firstLine = body.split("\n")[0].replace(/^create or replace function /i, "").replace(/\)$/, ")");
    assert.equal(firstLine, expectedSignature);
  });

  test(`1.3 ${name}: exactly one organization_payment_active() call was added`, () => {
    const body = extractFunctionBody(RPC_SOURCE, name);
    const occurrences = (body.match(/organization_payment_active\(/g) ?? []).length;
    assert.equal(occurrences, 1, `expected exactly one organization_payment_active() call in ${name}`);
  });
}

// The exact guard text added to each of the 6 service-role-aware functions,
// pinned verbatim rather than pattern-matched - each mirrors that specific
// function's own pre-existing conditional style (a single combined
// condition possibly split across two lines, a nested nested-block-style
// "if not v_is_service_role then ... end if;", or the else branch of an
// "if v_is_service_role then ... else ... end if;"), not a style imposed
// uniformly across all 6. This is more precise than a generic structural
// heuristic and equally rigorous: it directly proves the guard text that
// was written for each function actually appears in the migration, in a
// position that is textually subordinate to a v_is_service_role check.
const EXPECTED_SERVICE_ROLE_GUARDS: Record<string, string> = {
  resolve_automation_incidents_by_fingerprint: `    if not public.organization_payment_active(p_organization_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;`,
  record_automation_incident_signal: `    if not public.organization_payment_active(p_organization_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;`,
  create_automation_event: `    if not public.organization_payment_active(v_org_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;`,
  start_workflow_execution: `  if not v_is_service_role and not public.organization_payment_active(v_org_id) then
    raise exception 'Automation event not found';
  end if;`,
  complete_workflow_execution: `  if not v_is_service_role
     and not public.organization_payment_active(v_execution.organization_id) then
    raise exception 'Organization payment is not active';
  end if;`,
  fail_workflow_execution: `  if not v_is_service_role
     and not public.organization_payment_active(v_execution.organization_id) then
    raise exception 'Organization payment is not active';
  end if;`,
};

for (const name of SERVICE_ROLE_AWARE) {
  test(`1.4 ${name}: has a v_is_service_role branch, and the new payment check is written to skip it (not v_is_service_role)`, () => {
    const body = extractFunctionBody(RPC_SOURCE, name);
    assert.match(body, /v_is_service_role/, `${name} is expected to have a service_role branch`);
    assert.ok(body.includes(EXPECTED_SERVICE_ROLE_GUARDS[name]), `${name}'s payment check must appear exactly in the position that keeps it subordinate to v_is_service_role, so service_role calls are never blocked`);
  });
}

for (const name of ALWAYS_USER_ONLY) {
  test(`1.5 ${name}: has no service_role branch (matches the live function's actual shape - always requires auth.uid()), so the payment check is unconditional`, () => {
    const body = extractFunctionBody(RPC_SOURCE, name);
    assert.doesNotMatch(body, /v_is_service_role/, `${name} was not expected to have a service_role branch - if this fails, the function's shape changed`);
    const checkLine = body.split("\n").find((l) => l.includes("organization_payment_active("));
    assert.ok(checkLine, `expected to find the payment check line in ${name}`);
    assert.doesNotMatch(checkLine!, /v_is_service_role/, `${name}'s payment check must be unconditional`);
  });
}

test("1.6 the first migration (20260921150000_payment_gate_rls_enforcement.sql) was not modified - it still defines organization_payment_active() exactly as before, and no restrictive-policy loop text changed", () => {
  assert.match(RLS_SOURCE, /create or replace function public\.organization_payment_active\(target_org_id uuid\)/);
  assert.match(RLS_SOURCE, /as restrictive for all to public using/);
});

test("1.7 no existing authorization check text (is_org_admin/is_org_member/Not authorized) was removed from any of the 12 functions - each still contains at least as many occurrences as the live database version", () => {
  const originalAuthCallCounts: Record<string, number> = {
    merge_contacts: 1, // is_org_admin
    acknowledge_automation_incident: 1, // is_org_admin
    resolve_automation_incident: 1, // is_org_admin
    resolve_automation_incidents_by_fingerprint: 1, // is_org_member
    record_automation_incident_signal: 1, // is_org_member
    create_automation_event: 0, // membership resolved by direct select, not is_org_member/is_org_admin
    start_workflow_execution: 1, // is_org_member
    complete_workflow_execution: 1, // is_org_member
    fail_workflow_execution: 1, // is_org_member
    create_automation_audit_event: 1, // is_org_admin
    create_organization_audit_event: 1, // is_org_admin
    create_review_referral_audit_event: 1, // is_org_member
  };
  for (const [name, expectedCount] of Object.entries(originalAuthCallCounts)) {
    const body = extractFunctionBody(RPC_SOURCE, name);
    const actualCount = (body.match(/is_org_(member|admin)\(/g) ?? []).length;
    assert.equal(actualCount, expectedCount, `${name}: expected ${expectedCount} is_org_member/is_org_admin call(s), found ${actualCount}`);
  }
});

// ===========================================================================
// SECTION 2 - LIVE, against the CURRENT unmigrated database
// (4 representative RPCs: merge_contacts, acknowledge_automation_incident,
// create_automation_event, start_workflow_execution)
// ===========================================================================

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let orgA: string;
let orgB: string;
let userAId: string;
let sessionA: Awaited<ReturnType<typeof createSessionFor>>;

async function createSessionFor(email: string, password: string) {
  const { data: signIn, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !signIn.session) throw error ?? new Error("no session");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
}

async function setOrgAStatus(status: "payment_required" | "active" | "suspended" | "cancelled") {
  const { error } = await service.from("organizations").update({ payment_status: status }).eq("id", orgA);
  if (error) throw error;
}

before(async () => {
  const { data: a, error: aErr } = await service.from("organizations").insert({ name: "Payment Gate RPC Test Org A" }).select("id").single();
  if (aErr) throw aErr;
  orgA = a!.id;
  const { data: b, error: bErr } = await service.from("organizations").insert({ name: "Payment Gate RPC Test Org B" }).select("id").single();
  if (bErr) throw bErr;
  orgB = b!.id;
  await service.from("organizations").update({ payment_status: "active" }).eq("id", orgB);

  const email = `payment-gate-rpc-a-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";
  const { data: userA, error: userAErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (userAErr) throw userAErr;
  userAId = userA.user!.id;
  const { error: memberErr } = await service.from("organization_members").insert({ organization_id: orgA, user_id: userAId, role: "owner" });
  if (memberErr) throw memberErr;

  sessionA = await createSessionFor(email, password);
});

after(async () => {
  await service.from("organizations").delete().eq("id", orgA);
  await service.from("organizations").delete().eq("id", orgB);
  await service.auth.admin.deleteUser(userAId);
});

test("2.1 merge_contacts: an active org's own admin can call it successfully - already true today, must remain true", async () => {
  await setOrgAStatus("active");
  const { data: c1 } = await service.from("contacts").insert({ organization_id: orgA, first_name: "Source" }).select("id").single();
  const { data: c2 } = await service.from("contacts").insert({ organization_id: orgA, first_name: "Target" }).select("id").single();
  const { error } = await sessionA.rpc("merge_contacts", { p_organization_id: orgA, p_source_contact_id: c1!.id, p_target_contact_id: c2!.id });
  assert.equal(error, null, "an active org's own admin must be able to call merge_contacts");
});

test("2.2 merge_contacts: a payment_required org's own admin can currently still call it - EXPECTED TO FAIL until the RPC migration is applied (live proof of the bypass)", async () => {
  await setOrgAStatus("payment_required");
  const { data: c1 } = await service.from("contacts").insert({ organization_id: orgA, first_name: "Source2" }).select("id").single();
  const { data: c2 } = await service.from("contacts").insert({ organization_id: orgA, first_name: "Target2" }).select("id").single();
  const { error } = await sessionA.rpc("merge_contacts", { p_organization_id: orgA, p_source_contact_id: c1!.id, p_target_contact_id: c2!.id });
  assert.ok(error, "once the migration is applied, an unpaid org's own admin must be rejected by merge_contacts");
});

test("2.3 merge_contacts: cross-org spoofing remains rejected regardless of payment status - org A's admin cannot merge org B's contacts by naming org B's id", async () => {
  await setOrgAStatus("active");
  const { data: c1 } = await service.from("contacts").insert({ organization_id: orgB, first_name: "BSource" }).select("id").single();
  const { data: c2 } = await service.from("contacts").insert({ organization_id: orgB, first_name: "BTarget" }).select("id").single();
  const { error } = await sessionA.rpc("merge_contacts", { p_organization_id: orgB, p_source_contact_id: c1!.id, p_target_contact_id: c2!.id });
  assert.ok(error, "org A's admin must never be able to merge org B's contacts, independent of this migration - this is the existing is_org_admin check");
});

test("2.4 acknowledge_automation_incident: an active org's own admin can call it successfully - already true today, must remain true", async () => {
  await setOrgAStatus("active");
  const { data: incident } = await service
    .from("automation_incidents")
    .insert({ organization_id: orgA, category: "workflow_failed", severity: "warning", fingerprint: `test-${Date.now()}-1`, title: "Test incident" })
    .select("id")
    .single();
  const { error } = await sessionA.rpc("acknowledge_automation_incident", { p_incident_id: incident!.id });
  assert.equal(error, null, "an active org's own admin must be able to acknowledge their own incident");
});

test("2.5 acknowledge_automation_incident: a suspended org's own admin can currently still call it - EXPECTED TO FAIL until the RPC migration is applied", async () => {
  await setOrgAStatus("suspended");
  const { data: incident } = await service
    .from("automation_incidents")
    .insert({ organization_id: orgA, category: "workflow_failed", severity: "warning", fingerprint: `test-${Date.now()}-2`, title: "Test incident 2" })
    .select("id")
    .single();
  const { error } = await sessionA.rpc("acknowledge_automation_incident", { p_incident_id: incident!.id });
  assert.ok(error, "once the migration is applied, a suspended org's own admin must be rejected by acknowledge_automation_incident");
});

test("2.6 create_automation_event (authenticated-user path): an active org's own member can call it successfully - already true today, must remain true", async () => {
  await setOrgAStatus("active");
  const { error } = await sessionA.rpc("create_automation_event", {
    p_event_type: "test.event",
    p_entity_type: null,
    p_entity_id: null,
    p_payload: {},
    p_idempotency_key: `test-${Date.now()}-active`,
  });
  assert.equal(error, null, "an active org's own member must be able to call create_automation_event");
});

test("2.7 create_automation_event (authenticated-user path): a cancelled org's own member can currently still call it - EXPECTED TO FAIL until the RPC migration is applied", async () => {
  await setOrgAStatus("cancelled");
  const { error } = await sessionA.rpc("create_automation_event", {
    p_event_type: "test.event",
    p_entity_type: null,
    p_entity_id: null,
    p_payload: {},
    p_idempotency_key: `test-${Date.now()}-cancelled`,
  });
  assert.ok(error, "once the migration is applied, a cancelled org's own member must be rejected by create_automation_event");
});

test("2.8 create_automation_event + start_workflow_execution (service_role path): succeed regardless of payment_status, today and after the migration - service_role must never be blocked", async () => {
  await setOrgAStatus("payment_required"); // deliberately unpaid, to prove service_role is unaffected by payment_status either way
  const { data: eventRows, error: eventErr } = await service.rpc("create_automation_event", {
    p_event_type: "test.service_role_event",
    p_entity_type: null,
    p_entity_id: null,
    p_payload: {},
    p_idempotency_key: `test-${Date.now()}-service-role`,
    p_organization_id: orgA,
  });
  assert.equal(eventErr, null, "service_role must be able to call create_automation_event for an unpaid org (used by the public lead-capture endpoint)");
  const eventId = (eventRows as Array<{ id: string }>)[0].id;

  const { error: execErr } = await service.rpc("start_workflow_execution", {
    p_automation_event_id: eventId,
    p_workflow_name: "test_workflow",
    p_metadata: {},
  });
  assert.equal(execErr, null, "service_role must be able to call start_workflow_execution for an unpaid org - this is the automation dispatch machinery itself, which must keep running regardless of the gate");
});
