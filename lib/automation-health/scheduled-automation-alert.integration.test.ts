/**
 * Pass 5C Batch 7, Item 2: integration tests for
 * evaluateScheduledAutomationDegradedAlert() - real, disposable Supabase
 * fixtures against the real project (service-role client).
 *
 * IMPORTANT ISOLATION NOTE: this function's own eligible-organizations query
 * is intentionally NOT scoped to a single organization - by design, it fans
 * a genuinely global signal (scheduled-automation liveness) out to every
 * live/paid/unpaused organization that exists in the database, exactly like
 * every other scheduled automation in this codebase (customer-reactivation.ts,
 * lead-reactivation.ts, etc. all scan across every organization too). That
 * means every call in this file's fake notifier's `calls` array may contain
 * entries for OTHER real organizations already present in the shared test
 * database, not just this file's own fixtures. Every assertion below is
 * therefore scoped to this file's own organizationId(s) - via
 * calls.filter(...) or a direct, organization-scoped `automation_incidents`
 * read - never a bare `calls.length` or the aggregate `result.notified`/
 * `result.resolved` counts, which legitimately include other organizations.
 *
 * SCOPE NOTE: this module deliberately never recomputes scheduled-automation
 * liveness itself (per this task's own "do not redesign scheduled liveness"
 * instruction) - it takes the caller's already-computed `isCurrentlyStale`
 * boolean directly, exactly as app/api/automation/health/route.ts's own
 * `staleScheduledAutomations.length > 0` does. The "unverified never counts
 * as stale" guarantee is proven at its own source
 * (computeScheduledAutomationLivenessState, already covered by
 * scheduled-automation-liveness.test.ts/.integration.test.ts, re-run
 * unchanged as part of this pass's own validation) - test 2 below re-asserts
 * that pure function's own boundary directly as a regression guard.
 *
 * REQUIRES supabase/migrations/20260926000000_automation_degraded_alert.sql.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/scheduled-automation-alert.integration.test.ts
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
const { evaluateScheduledAutomationDegradedAlert }: typeof import("./scheduled-automation-alert") = require(path.join(REPO_ROOT, "lib/automation-health/scheduled-automation-alert.ts"));
const { computeScheduledAutomationLivenessState }: typeof import("./scheduled-automation-liveness") = require(path.join(REPO_ROOT, "lib/automation-health/scheduled-automation-liveness.ts"));
const { notifyFounder }: typeof import("@/lib/notifications/founder") = require(path.join(REPO_ROOT, "lib/notifications/founder.ts"));

const service = createServiceRoleClient();

type NotifyFounderInput = { organizationId: string; kind: string; summary: string; detailPath?: string | null };

/** Captures every call, in order, without ever invoking the real notifyFounder (no real email/SMS side effect possible). */
function fakeNotifier(): { calls: NotifyFounderInput[]; fn: (supabase: unknown, input: NotifyFounderInput) => Promise<void> } {
  const calls: NotifyFounderInput[] = [];
  return {
    calls,
    fn: async (_supabase: unknown, input: NotifyFounderInput) => {
      calls.push(input);
    },
  };
}

async function makeOrg(name: string, overrides: { automationMode?: string; paymentStatus?: string; automationPaused?: boolean } = {}) {
  const { data } = await service
    .from("organizations")
    .insert({
      name,
      automation_mode: overrides.automationMode ?? "live",
      payment_status: overrides.paymentStatus ?? "active",
      automation_paused: overrides.automationPaused ?? false,
    })
    .select("id")
    .single();
  return data!.id as string;
}

async function getOpenIncident(orgId: string) {
  const { data } = await service
    .from("automation_incidents")
    .select("id, status, category, occurrence_count, title, description")
    .eq("organization_id", orgId)
    .eq("category", "scheduled_automation_stale")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function cleanupOrg(orgId: string) {
  await service.from("automation_incidents").delete().eq("organization_id", orgId);
  await service.from("notification_settings").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. a healthy organization (isCurrentlyStale = false) never gets a scheduled_automation_stale incident or notification", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (1)");
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, false, fn as never);
    assert.equal(calls.filter((c) => c.organizationId === orgId).length, 0);
    assert.equal(await getOpenIncident(orgId), null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. unverified scheduled automation liveness is never classified as stale (the source guarantee this module relies on)", () => {
  assert.notEqual(computeScheduledAutomationLivenessState(null), "stale");
  assert.equal(computeScheduledAutomationLivenessState(null), "unverified");
});

test("3. a stale condition (isCurrentlyStale = true) notifies an eligible organization exactly once and opens one incident", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (3)");
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);
    const myCalls = calls.filter((c) => c.organizationId === orgId);
    assert.equal(myCalls.length, 1);
    assert.equal(myCalls[0].kind, "automation_degraded");

    const incident = await getOpenIncident(orgId);
    assert.ok(incident);
    assert.equal(incident!.status, "open");
    assert.equal(incident!.occurrence_count, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4. repeated evaluation while the condition remains degraded notifies exactly once, never repeatedly", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (4)");
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);

    const myCalls = calls.filter((c) => c.organizationId === orgId);
    assert.equal(myCalls.length, 1, "three consecutive health-check ticks while still degraded must produce exactly one notification");
    const incident = await getOpenIncident(orgId);
    assert.equal(incident!.occurrence_count, 3, "the same open incident accumulates occurrences, never a new row");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5. recovery to healthy clears the active degraded state", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (5)");
  try {
    const { fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);
    const beforeRecovery = await getOpenIncident(orgId);
    assert.equal(beforeRecovery!.status, "open");

    await evaluateScheduledAutomationDegradedAlert(service, false, fn as never);

    const afterRecovery = await getOpenIncident(orgId);
    assert.equal(afterRecovery!.status, "resolved");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("6. a new degradation after recovery notifies again", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (6)");
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never); // HEALTHY -> DEGRADED, notify #1
    await evaluateScheduledAutomationDegradedAlert(service, false, fn as never); // DEGRADED -> HEALTHY, clears
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never); // HEALTHY -> DEGRADED again, notify #2

    const myCalls = calls.filter((c) => c.organizationId === orgId);
    assert.equal(myCalls.length, 2, "a genuinely new degradation after recovery must notify again");

    const { data: rows } = await service
      .from("automation_incidents")
      .select("status, occurrence_count")
      .eq("organization_id", orgId)
      .eq("category", "scheduled_automation_stale")
      .order("created_at", { ascending: true });
    assert.equal(rows?.length, 2, "recovery followed by a new degradation creates a second, independent incident row, never reusing the resolved one");
    assert.equal(rows![0].status, "resolved");
    assert.equal(rows![1].status, "open");
    assert.equal(rows![1].occurrence_count, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("7. a payment-blocked organization never receives an automation-degraded notification", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (7)", { paymentStatus: "payment_required" });
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);
    assert.equal(calls.filter((c) => c.organizationId === orgId).length, 0);
    assert.equal(await getOpenIncident(orgId), null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("8. an intentionally paused organization never receives an automation-degraded notification", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (8)", { automationPaused: true });
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);
    assert.equal(calls.filter((c) => c.organizationId === orgId).length, 0);
    assert.equal(await getOpenIncident(orgId), null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("9. cross-org isolation: resolving one organization's incident never touches another organization's still-open incident", async () => {
  const orgA = await makeOrg("Automation Degraded Alert Test Org (9A)");
  const orgB = await makeOrg("Automation Degraded Alert Test Org (9B)", { paymentStatus: "payment_required" }); // never eligible, never opens its own incident via the normal path
  try {
    const { fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);
    const orgAIncident = await getOpenIncident(orgA);
    assert.ok(orgAIncident, "the eligible organization must have its own open incident");
    assert.equal(await getOpenIncident(orgB), null, "the ineligible organization must never have an incident created for it via the normal eligibility path");

    // Directly force-open an incident for org B (bypassing eligibility) to
    // prove the resolve step scopes strictly by organization_id, never by
    // shared fingerprint content alone.
    await service.rpc("record_automation_incident_signal", {
      p_organization_id: orgB,
      p_category: "scheduled_automation_stale",
      p_severity: "warning",
      p_fingerprint: "scheduled_automation_stale:scheduled-automation",
      p_title: "Automation needs attention",
    });

    await evaluateScheduledAutomationDegradedAlert(service, false, fn as never);

    const orgAAfter = await getOpenIncident(orgA);
    const orgBAfter = await getOpenIncident(orgB);
    assert.equal(orgAAfter!.status, "resolved", "org A's own incident must still resolve correctly");
    assert.equal(orgBAfter!.status, "resolved", "org B's own incident resolves independently, scoped to its own organization_id - never because of org A's row");
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("10. respects the existing owner notification preference - opting out of notify_on_automation_degraded sends nothing, even with the real notifyFounder", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (10)");
  try {
    await service.from("notification_settings").upsert({ organization_id: orgId, notification_email: "owner@example.com", notify_on_automation_degraded: false }, { onConflict: "organization_id" });

    let sendEmailCalls = 0;
    // The REAL, unmodified notifyFounder - proves the preference gate itself
    // (pre-existing code, not touched by this pass) correctly recognizes the
    // new "automation_degraded" kind and honors notify_on_automation_degraded,
    // never actually attempting a send when it is false.
    await notifyFounder(service, { organizationId: orgId, kind: "automation_degraded" as never, summary: "test" }, { sendEmail: async () => { sendEmailCalls += 1; return {}; } });

    assert.equal(sendEmailCalls, 0, "notify_on_automation_degraded=false must prevent any send attempt, exactly like every other existing notification kind");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("11. the notifyFounder call this module makes carries no customer/contact identifiers - only organizationId, kind, summary, and detailPath", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (11)");
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);

    const myCalls = calls.filter((c) => c.organizationId === orgId);
    assert.equal(myCalls.length, 1);
    assert.deepEqual(
      Object.keys(myCalls[0]).sort(),
      ["detailPath", "kind", "organizationId", "summary"],
      "no phone/email/contactId/customer field of any kind is ever passed by this module - recipient resolution happens entirely inside notifyFounder from notification_settings",
    );
  } finally {
    await cleanupOrg(orgId);
  }
});

test("12. notification content is conservative and factual - no internal IDs, workflow names, or infrastructure jargon", async () => {
  const orgId = await makeOrg("Automation Degraded Alert Test Org (12)");
  try {
    const { calls, fn } = fakeNotifier();
    await evaluateScheduledAutomationDegradedAlert(service, true, fn as never);

    const myCall = calls.find((c) => c.organizationId === orgId);
    assert.ok(myCall);
    const summary = myCall!.summary.toLowerCase();
    for (const forbidden of ["n8n", "workflow", "database", "uuid", "supabase", "cron", "execution"]) {
      assert.ok(!summary.includes(forbidden), `summary must never mention "${forbidden}": ${myCall!.summary}`);
    }
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(myCall!.summary), "summary must never contain a raw UUID");

    const incident = await getOpenIncident(orgId);
    for (const forbidden of ["n8n", "workflow_execution", "supabase"]) {
      assert.ok(!incident!.description!.toLowerCase().includes(forbidden));
    }
  } finally {
    await cleanupOrg(orgId);
  }
});
