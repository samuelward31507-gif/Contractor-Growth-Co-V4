/**
 * Integration tests for Growth System Completion Pass 2, Part 7 (Old
 * Customer Reactivation) - lib/automation/customer-reactivation.ts. Real,
 * disposable Supabase fixtures, driven entirely through the service-role
 * client (this automation only ever runs from the scheduled cron route -
 * app/api/automation/customer-reactivation/route.ts - never from a user
 * session).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/customer-reactivation.integration.test.ts
 */
import { test, after } from "node:test";
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
const { processCustomerReactivation, isReactivationDue }: typeof import("./customer-reactivation") = require(
  path.join(REPO_ROOT, "lib/automation/customer-reactivation.ts"),
);
const { DAYS_OF_WEEK }: typeof import("@/lib/settings/queries") = require(path.join(REPO_ROOT, "lib/settings/queries.ts"));

const service = createServiceRoleClient();

const NOW = new Date();

/** Twilio isn't configured in this local/test environment - this test seam (see lib/messaging/outbound.ts) injects a deterministic fake send so "sent" outcomes are real, rather than failing on an unconfigured provider. */
async function fakeSendSms() {
  return { ok: true as const, providerMessageId: `test-${Math.random().toString(36).slice(2)}` };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

type Fixture = { organizationId: string; contactId: string };

const fixtures: Fixture[] = [];

async function makeOrg(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data } = await service
    .from("organizations")
    .insert({ name: `Customer Reactivation Test Org ${Math.random().toString(36).slice(2)}`, payment_status: "active", automation_mode: "live", ...overrides })
    .select("id")
    .single();
  return data!.id as string;
}

async function makeContact(organizationId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { data } = await service
    .from("contacts")
    .insert({ organization_id: organizationId, phone: `+1555555${Math.floor(1000 + Math.random() * 8999)}`, first_name: "Jordan", ...overrides })
    .select("id")
    .single();
  return data!.id as string;
}

async function makeCompletedJob(organizationId: string, contactId: string, completedAt: string, overrides: Record<string, unknown> = {}) {
  const { data } = await service
    .from("jobs")
    .insert({ organization_id: organizationId, contact_id: contactId, title: "Gutter Cleaning", status: "completed", completed_at: completedAt, ...overrides })
    .select("id")
    .single();
  return data!.id as string;
}

async function setConfig(organizationId: string, config: Record<string, unknown>) {
  await service.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "customer-reactivation", config },
    { onConflict: "organization_id,automation_id" },
  );
}

async function disableAutomation(organizationId: string) {
  await service.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "customer-reactivation", enabled: false },
    { onConflict: "organization_id,automation_id" },
  );
}

async function setAllDaysClosed(organizationId: string) {
  const rows = DAYS_OF_WEEK.map((day) => ({ organization_id: organizationId, day_of_week: day.value, is_open: false, open_time: null, close_time: null }));
  await service.from("business_hours").insert(rows);
}

async function cleanupOrg(organizationId: string) {
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("automation_settings").delete().eq("organization_id", organizationId);
  await service.from("business_hours").delete().eq("organization_id", organizationId);
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("estimates").delete().eq("organization_id", organizationId);
  await service.from("jobs").delete().eq("organization_id", organizationId);
  await service.from("leads").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
}

after(async () => {
  for (const fixture of fixtures) {
    await cleanupOrg(fixture.organizationId);
  }
});

test("1. isReactivationDue: the pure eligibility check is driven by the configured threshold, not a hardcoded constant", () => {
  assert.equal(isReactivationDue(daysAgo(200), { inactivity_days: 180, respect_business_hours: false }, NOW), true);
  assert.equal(isReactivationDue(daysAgo(100), { inactivity_days: 180, respect_business_hours: false }, NOW), false);
  assert.equal(isReactivationDue(daysAgo(100), { inactivity_days: 90, respect_business_hours: false }, NOW), true);
});

test("2. a customer whose last completed job crossed the threshold receives a real, fact-based send naming their actual name and service - no fake/hardcoded service", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId, { first_name: "Priya" });
  await makeCompletedJob(organizationId, contactId, daysAgo(60), { title: "Roof Inspection" });

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "sent");

  const { data: message } = await service
    .from("messages")
    .select("body")
    .eq("organization_id", organizationId)
    .eq("direction", "outbound")
    .maybeSingle();
  assert.ok(message?.body.includes("Priya"), "message must use the customer's real first name");
  assert.ok(message?.body.includes("Roof Inspection"), "message must name the real, stored job/service - never a fabricated one");
});

test("3. a customer whose last completed job has NOT yet crossed the configured threshold is not contacted", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 180, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(30));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  assert.equal(result.outcomes.find((o) => o.contactId === contactId), undefined, "not yet due - never even a candidate");
});

test("4. a customer with an open lead (active opportunity) is excluded, even though their last job is long past due", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));
  await service.from("leads").insert({ organization_id: organizationId, contact_id: contactId, source: "referral", status: "new", temperature: "warm" });

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "active_engagement");
});

test("5. a customer with another active (scheduled) job is excluded", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));
  await service.from("jobs").insert({ organization_id: organizationId, contact_id: contactId, title: "Follow-up Repair", status: "scheduled" });

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "active_engagement");
});

test("6. a customer with an already-open conversation is excluded, never interjecting an unrelated ping into an active thread", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));
  await service.from("conversations").insert({ organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open" });

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "has_open_conversation");
});

test("7. an opted-out contact is blocked by the safe outbound gate, never sent to", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId, { sms_opt_out: true });
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "blocked");
  assert.equal((outcome as { reason: string }).reason, "contact_opted_out");
});

test("7b. an organization whose payment has lapsed (suspended) never has a new campaign message dispatched", async () => {
  const organizationId = await makeOrg({ payment_status: "suspended" });
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "payment_inactive");

  const { data: events } = await service.from("automation_events").select("id").eq("organization_id", organizationId);
  assert.equal((events ?? []).length, 0, "no automation event should even be created for a payment-inactive organization");
});

test("7c. an organization still in onboarding (payment_required, never yet active) never has a campaign message dispatched", async () => {
  const organizationId = await makeOrg({ payment_status: "payment_required" });
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "payment_inactive");
});

test("8. automation pause (founder kill switch) blocks the send", async () => {
  const organizationId = await makeOrg({ automation_paused: true });
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "blocked");
  assert.equal((outcome as { reason: string }).reason, "organization_automation_paused");
});

test("9. an organization not switched to live (go-live protection) never has a real customer contacted", async () => {
  const organizationId = await makeOrg({ automation_mode: "test" });
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "blocked");
  assert.equal((outcome as { reason: string }).reason, "organization_not_live");
});

test("10. the automation-enable toggle is respected - a disabled organization gets no event and no send", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  await disableAutomation(organizationId);
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "skipped_disabled");

  const { data: events } = await service.from("automation_events").select("id").eq("organization_id", organizationId);
  assert.equal((events ?? []).length, 0);
});

test("11. deduplication: running the scan twice never sends a second campaign message for the same dormancy period", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const first = await processCustomerReactivation(service, NOW, fakeSendSms);
  assert.equal(first.outcomes.find((o) => o.contactId === contactId)?.outcome, "sent");

  const second = await processCustomerReactivation(service, NOW, fakeSendSms);
  assert.equal(second.outcomes.find((o) => o.contactId === contactId)?.outcome, "skipped_duplicate");

  const { data: messages } = await service.from("messages").select("id").eq("organization_id", organizationId).eq("direction", "outbound");
  assert.equal((messages ?? []).length, 1, "exactly one outbound message must exist for this contact, never two");
});

test("12. business hours: respect_business_hours=true with every day configured closed blocks the send", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: true });
  await setAllDaysClosed(organizationId);
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "blocked");
  assert.equal((outcome as { reason: string }).reason, "outside_business_hours");
});

test("13. business hours: the exact same all-days-closed configuration does NOT block the send when respect_business_hours=false - the config flag, not just the hours, gates it", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  await setAllDaysClosed(organizationId);
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = result.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "sent");
});

test("14. organization isolation: each organization's own configured inactivity threshold applies only to its own customers", async () => {
  const orgA = await makeOrg();
  const orgB = await makeOrg();
  fixtures.push({ organizationId: orgA, contactId: "" }, { organizationId: orgB, contactId: "" });
  await setConfig(orgA, { inactivity_days: 30, respect_business_hours: false });
  await setConfig(orgB, { inactivity_days: 400, respect_business_hours: false });

  const contactA = await makeContact(orgA);
  await makeCompletedJob(orgA, contactA, daysAgo(200));
  const contactB = await makeContact(orgB);
  await makeCompletedJob(orgB, contactB, daysAgo(200));

  const result = await processCustomerReactivation(service, NOW, fakeSendSms);
  assert.equal(result.outcomes.find((o) => o.contactId === contactA)?.outcome, "sent", "org A's shorter threshold makes this customer due");
  assert.equal(result.outcomes.find((o) => o.contactId === contactB), undefined, "org B's longer threshold means this customer was never a candidate");

  const { data: messagesB } = await service.from("messages").select("id").eq("organization_id", orgB);
  assert.equal((messagesB ?? []).length, 0, "organization B must never receive a message driven by organization A's data or threshold");
});

test("15. a genuinely later completed job starts a fresh dormancy period, eligible for its own future reactivation - the idempotency key is anchored to the job, not just the contact", async () => {
  const organizationId = await makeOrg();
  fixtures.push({ organizationId, contactId: "" });
  await setConfig(organizationId, { inactivity_days: 30, respect_business_hours: false });
  const contactId = await makeContact(organizationId);
  await makeCompletedJob(organizationId, contactId, daysAgo(90), { title: "Gutter Cleaning" });

  const first = await processCustomerReactivation(service, NOW, fakeSendSms);
  assert.equal(first.outcomes.find((o) => o.contactId === contactId)?.outcome, "sent");

  // The reactivation conversation from the first touch is still open - the
  // "no recent active conversation" safety guard (test 6) correctly keeps
  // blocking a second ping into that same thread until it's closed, exactly
  // as it should for any other open thread. Closing it here simulates the
  // realistic case: that conversation was eventually wrapped up, and later
  // the customer came back for a new job, which itself completes and
  // crosses the threshold - the most-recently-completed-job scan now
  // anchors to THIS job, a genuinely new dormancy period.
  await service.from("conversations").update({ status: "closed" }).eq("organization_id", organizationId).eq("contact_id", contactId);
  await makeCompletedJob(organizationId, contactId, daysAgo(60), { title: "Fence Repair" });

  const second = await processCustomerReactivation(service, NOW, fakeSendSms);
  const outcome = second.outcomes.find((o) => o.contactId === contactId);
  assert.equal(outcome?.outcome, "sent", "a new completed job, past its own threshold, is a genuinely new, sendable occurrence");

  const { data: messages } = await service.from("messages").select("body").eq("organization_id", organizationId).eq("direction", "outbound").order("created_at", { ascending: true });
  assert.equal((messages ?? []).length, 2);
  assert.ok(messages![1].body.includes("Fence Repair"));
});
