/**
 * Pass 1 (opportunity sync failure-safety): a failed database read must never
 * be treated as "zero rows". Before this pass every detector and sync read in
 * lib/opportunities/detect.ts used `data ?? []`, so a failed read could
 * resolve real open opportunities (a failed primary read), insert false ones
 * (a failed exclusion read), or re-open dismissed ones (a failed dismissal
 * read). Now every read goes through checked(), and syncOpportunities aborts
 * before its first write.
 *
 * Against a filter-aware in-memory fake client (the same shape as
 * detect.invoices.test.ts's) with per-read failure injection - no database.
 * The fixture below makes every one of the sync's reads actually run, so the
 * parameterized test fails each read in turn.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/sync.read-failure.test.ts
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { syncOpportunities, detectAllOpportunityCandidates }: typeof import("./detect") = require("./detect.ts");
const { scheduleOpportunitySync }: typeof import("./background-sync") = require("./background-sync.ts");

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "neq" | "in" | "not" | "lte" | "gte" | "lt" | "is"; column: string; value: unknown };
type Call = { table: string; op: string; filters: Filter[]; failed: boolean };
type FailureError = { message: string; code?: string; details?: string; hint?: string };

/**
 * In-memory tables with the filter operators detect.ts uses. `failAt(n)` makes
 * the n-th select (0-based, in issue order) return { data: null, error } - the
 * exact shape postgrest-js returns for both PostgREST and network failures.
 */
function makeFakeSupabase(tables: Record<string, Row[]>, options: { failSelectAt?: number; error?: FailureError; throwOnTable?: string } = {}) {
  const calls: Call[] = [];
  let selects = 0;
  function builder(table: string) {
    if (options.throwOnTable === table) throw new TypeError("unexpected client bug");
    const filters: Filter[] = [];
    let op = "select";
    let payload: unknown;
    let maybe = false;
    let columns = "";
    let page: [number, number] | null = null;
    const matches = (row: Row) =>
      filters.every(({ kind, column, value }) => {
        const actual = row[column];
        if (kind === "eq") return actual === value;
        if (kind === "neq") return actual !== value;
        if (kind === "in") return (value as unknown[]).includes(actual);
        if (kind === "is") return actual === value;
        if (kind === "not") return actual != null; // only ever `.not(col, "is", null)`
        if (kind === "lte") return String(actual) <= String(value);
        if (kind === "gte") return String(actual) >= String(value);
        return String(actual) < String(value);
      });
    function execute() {
      const rows = (tables[table] ??= []);
      const failed = op === "select" && selects++ === options.failSelectAt;
      calls.push({ table, op, filters: [...filters], failed });
      if (failed) return { data: null, error: options.error ?? { message: "canceling statement due to statement timeout", code: "57014" } };
      let result: Row[] = [];
      if (op === "select") result = rows.filter(matches);
      // Phase 2H: the uncontacted-lead read joins each conversation to one
      // inbound or successfully sent outbound message of the same
      // organization (an inner join) - emulated here over the messages table.
      if (op === "select" && table === "conversations" && columns.includes("messages!inner")) {
        const qualifying = (message: Row, conversation: Row) =>
          message.conversation_id === conversation.id &&
          message.organization_id === conversation.organization_id &&
          (message.direction === "inbound" || (message.direction === "outbound" && ["sent", "delivered"].includes(String(message.status))));
        result = result.filter((conversation) => (tables.messages ?? []).some((message) => qualifying(message, conversation))).map((conversation) => ({ ...conversation, messages: [{ id: "m" }] }));
      }
      if (op === "select" && page) result = result.slice(page[0], page[1] + 1);
      else if (op === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const inserted = incoming.map((row, i) => ({ id: `${table}-${rows.length + i + 1}`, status: "open", created_at: "2026-10-20T00:00:00.000Z", ...row }));
        rows.push(...inserted);
        result = inserted;
      } else if (op === "update") {
        result = rows.filter(matches);
        for (const row of result) Object.assign(row, payload as Row);
      }
      if (maybe) return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
    const b: Record<string, unknown> = {
      select: (selected?: string) => (op === "select" && (columns = selected ?? ""), b),
      or: () => b,
      range: (from: number, to: number) => ((page = [from, to]), b),
      insert: (rows: unknown) => ((op = "insert"), (payload = rows), b),
      update: (patch: unknown) => ((op = "update"), (payload = patch), b),
      eq: (column: string, value: unknown) => (filters.push({ kind: "eq", column, value }), b),
      neq: (column: string, value: unknown) => (filters.push({ kind: "neq", column, value }), b),
      in: (column: string, value: unknown) => (filters.push({ kind: "in", column, value }), b),
      is: (column: string, value: unknown) => (filters.push({ kind: "is", column, value }), b),
      not: (column: string) => (filters.push({ kind: "not", column, value: null }), b),
      lte: (column: string, value: unknown) => (filters.push({ kind: "lte", column, value }), b),
      gte: (column: string, value: unknown) => (filters.push({ kind: "gte", column, value }), b),
      lt: (column: string, value: unknown) => (filters.push({ kind: "lt", column, value }), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => ((maybe = true), b),
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
        try {
          return resolve(execute());
        } catch (error) {
          if (reject) return reject(error);
          throw error;
        }
      },
    };
    return b;
  }
  const writes = () => calls.filter((call) => call.op !== "select");
  return { client: { from: builder } as unknown as SupabaseClient, calls, tables, writes };
}

const ORG = "org-a";
const NOW = new Date("2026-10-20T15:00:00.000Z");
const DAYS_AGO = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const ann = { id: "contact-ann", first_name: "Ann", last_name: "Lee", company_name: null, sms_opt_out: false };
const bo = { id: "contact-bo", first_name: "Bo", last_name: "Diaz", company_name: null, sms_opt_out: false };
const cy = { id: "contact-cy", first_name: "Cy", last_name: "Park", company_name: null, sms_opt_out: false };

/**
 * One organization whose data makes every conditional read run: a qualified
 * lead (-> appointments), a completed appointment with a lead (-> estimates),
 * a dormant customer (-> leads/appointments/estimates/jobs/contacts), completed
 * jobs (-> referral_requests, review_requests since review_url is set,
 * invoices), a cancelled appointment past its grace period (-> active
 * appointments), a live automation org with an old 'new' lead and a
 * conversation (-> conversations -> messages), an accepted estimate (-> jobs),
 * and an open lead-sourced opportunity whose condition is gone (-> the
 * lost-lead lookup). Plus a dismissed opportunity whose condition still holds.
 */
function fixture(): Record<string, Row[]> {
  return {
    organizations: [{ id: ORG, timezone: "America/Denver", review_url: "https://g.page/r/example", automation_mode: "live", payment_status: "active", automation_paused: false }],
    automation_settings: [],
    leads: [
      { id: "lead-qualified", organization_id: ORG, contact_id: ann.id, status: "qualified", service: "Roof", estimated_value: 1200, temperature: "warm", created_at: DAYS_AGO(10), contacts: ann },
      { id: "lead-new", organization_id: ORG, contact_id: bo.id, status: "new", service: "Gutters", estimated_value: null, temperature: "cold", created_at: DAYS_AGO(3), contacts: bo },
      { id: "lead-gone", organization_id: ORG, contact_id: ann.id, status: "lost", service: "Deck", estimated_value: null, temperature: "cold", created_at: DAYS_AGO(40), contacts: ann },
    ],
    appointments: [
      { id: "appt-completed", organization_id: ORG, contact_id: ann.id, lead_id: "lead-qualified", title: "Inspection", status: "completed", start_at: DAYS_AGO(5), updated_at: DAYS_AGO(5), contacts: ann },
      { id: "appt-cancelled", organization_id: ORG, contact_id: bo.id, lead_id: null, title: "Estimate visit", status: "cancelled", start_at: DAYS_AGO(6), updated_at: DAYS_AGO(6), contacts: bo },
      { id: "appt-no-show", organization_id: ORG, contact_id: ann.id, lead_id: null, title: "Follow-up", status: "no_show", start_at: DAYS_AGO(2), updated_at: DAYS_AGO(2), contacts: ann },
    ],
    estimates: [
      { id: "est-accepted", organization_id: ORG, contact_id: bo.id, lead_id: null, title: "Siding", amount: 5000, status: "accepted", responded_at: DAYS_AGO(3), sent_at: DAYS_AGO(9), contacts: bo },
      { id: "est-expired", organization_id: ORG, contact_id: ann.id, lead_id: null, title: "Paint", amount: 800, status: "expired", sent_at: DAYS_AGO(40), expires_at: DAYS_AGO(10), contacts: ann },
    ],
    jobs: [
      { id: "job-recent", organization_id: ORG, contact_id: bo.id, title: "Fence", amount: 900, status: "completed", completed_at: DAYS_AGO(5), created_at: DAYS_AGO(8), estimate_id: null, contacts: bo },
      { id: "job-old", organization_id: ORG, contact_id: cy.id, title: "Old roof", amount: 7000, status: "completed", completed_at: DAYS_AGO(400), created_at: DAYS_AGO(410), estimate_id: null, contacts: cy },
    ],
    invoices: [],
    contacts: [ann, bo, cy].map((contact) => ({ ...contact, organization_id: ORG })),
    conversations: [{ id: "conv-bo", organization_id: ORG, contact_id: bo.id }],
    messages: [],
    referral_requests: [],
    review_requests: [],
    opportunities: [
      // Open, lead-sourced, and no longer a candidate (the lead is lost) - a successful sync resolves it as 'lost'.
      { id: "opp-gone", organization_id: ORG, type: "qualified_lead_unbooked", source_entity_type: "lead", source_entity_id: "lead-gone", status: "open", title: "Ann Lee", description: "x", estimated_value: null, value_basis: null, metadata: {}, created_at: "2026-10-01T00:00:00.000Z" },
      // Open and still a candidate - a successful sync keeps it.
      { id: "opp-stale", organization_id: ORG, type: "stale_estimate", source_entity_type: "estimate", source_entity_id: "est-expired", status: "open", title: "Ann Lee", description: 'Estimate "Paint" expired with no customer decision recorded.', estimated_value: 800, value_basis: "estimates.amount", metadata: {}, created_at: "2026-10-02T00:00:00.000Z" },
      // Dismissed and its condition still holds - a successful sync must never re-open it.
      { id: "opp-dismissed", organization_id: ORG, type: "no_show", source_entity_type: "appointment", source_entity_id: "appt-no-show", status: "dismissed", title: "Ann Lee", description: "x", estimated_value: null, value_basis: null, metadata: {}, created_at: "2026-10-03T00:00:00.000Z" },
    ],
  };
}

const snapshot = (tables: Record<string, Row[]>) => JSON.stringify(tables.opportunities);

let logged: unknown[][] = [];
const realConsoleError = console.error;
beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => void logged.push(args);
});
afterEach(() => {
  console.error = realConsoleError;
});
const abortLogs = () => logged.filter((args) => args[0] === "[opportunities] sync aborted: read failed");

test("baseline: with every read succeeding, the fixture runs all 34 sync reads and the sync writes normally (resolves the gone lead as lost, keeps the stale estimate, never re-opens the dismissed no-show)", async () => {
  const fake = makeFakeSupabase(fixture());
  const result = await syncOpportunities(fake.client, ORG, NOW);
  const selects = fake.calls.filter((call) => call.op === "select");
  assert.equal(selects.length, 34, `every read ran: ${selects.map((call) => call.table).join(", ")}`);
  assert.equal(result.failed, undefined);
  assert.ok(result.created > 0 && result.resolved === 1, JSON.stringify(result));
  const byId = (id: string) => fake.tables.opportunities.find((row) => row.id === id)!;
  assert.equal(byId("opp-gone").status, "resolved");
  assert.equal(byId("opp-gone").resolution_reason, "lost");
  assert.equal(byId("opp-stale").status, "open");
  assert.equal(byId("opp-dismissed").status, "dismissed");
  assert.equal(fake.tables.opportunities.filter((row) => row.type === "no_show" && row.status === "open").length, 0, "the dismissed no-show is suppressed, not re-created");
  assert.equal(abortLogs().length, 0);
});

test("a successful read returning zero rows is still a real 'nothing here': the matching open opportunity resolves exactly as before", async () => {
  const tables = fixture();
  tables.estimates = tables.estimates.filter((row) => row.status !== "expired"); // the stale-estimate query now succeeds with zero rows
  const fake = makeFakeSupabase(tables);
  const result = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(result.failed, undefined);
  const stale = fake.tables.opportunities.find((row) => row.id === "opp-stale")!;
  assert.equal(stale.status, "resolved");
  assert.equal(stale.resolution_reason, "condition_no_longer_true");
});

test("every read, failed one at a time: the sync aborts with failed: true, performs zero writes, leaves every opportunity untouched, and logs which read failed", async () => {
  const baseline = makeFakeSupabase(fixture());
  await syncOpportunities(baseline.client, ORG, NOW);
  const readCount = baseline.calls.filter((call) => call.op === "select").length;
  assert.equal(readCount, 34); // Phase 2H: 36 -> 34 - the dormant contacts read joins its jobs read; conversations + messages are one join
  const failedReads = new Set<string>();

  for (let index = 0; index < readCount; index += 1) {
    logged = [];
    const tables = fixture();
    const before = snapshot(tables);
    const fake = makeFakeSupabase(tables, { failSelectAt: index });
    const result = await syncOpportunities(fake.client, ORG, NOW);
    const failedCall = fake.calls.find((call) => call.failed);
    assert.ok(failedCall, `read #${index} was issued`);
    assert.deepEqual(result, { created: 0, refreshed: 0, resolved: 0, unchanged: 0, suppressed: 0, failed: true }, `read #${index} (${failedCall.table})`);
    assert.deepEqual(fake.writes(), [], `read #${index} (${failedCall.table}): no resolve, insert or refresh after a failed read`);
    assert.equal(snapshot(fake.tables), before, `read #${index} (${failedCall.table}): opportunities unchanged`);
    const logs = abortLogs();
    assert.equal(logs.length, 1, `read #${index}: logged once`);
    const context = logs[0][1] as { organizationId: string; read: string; error: string };
    assert.equal(context.organizationId, ORG);
    assert.equal(context.error, "canceling statement due to statement timeout");
    failedReads.add(context.read);
  }
  // Every read is individually labelled, so a log line always says which read failed.
  assert.equal(failedReads.size, 34, [...failedReads].join(", "));
});

test("the destructive cases specifically: a failed primary read no longer resolves, a failed exclusion read no longer inserts, a failed dismissal read no longer re-opens, a failed automation-enabled read no longer fails open", async () => {
  const labelFor = async (index: number) => {
    logged = [];
    const fake = makeFakeSupabase(fixture(), { failSelectAt: index });
    await syncOpportunities(fake.client, ORG, NOW);
    return { read: (abortLogs()[0]?.[1] as { read: string }).read, writes: fake.writes().length, opportunities: fake.tables.opportunities };
  };
  const baseline = makeFakeSupabase(fixture());
  await syncOpportunities(baseline.client, ORG, NOW);
  const readLabels: string[] = [];
  for (let index = 0; index < 34; index += 1) readLabels.push((await labelFor(index)).read);

  for (const read of ["stale_estimate.estimates", "qualified_lead_unbooked.leads", "completed_job_no_review_request.organizations", "uncontacted_lead.organizations"]) {
    const outcome = await labelFor(readLabels.indexOf(read));
    assert.equal(outcome.read, read);
    assert.equal(outcome.writes, 0, `${read}: a failed primary read resolves nothing`);
    assert.equal(outcome.opportunities.find((row) => row.id === "opp-stale")!.status, "open");
  }
  for (const read of ["qualified_lead_unbooked.appointments", "completed_job_no_referral_request.referral_requests", "uncontacted_lead.contacted_conversations", "accepted_estimate_no_job.jobs"]) {
    const outcome = await labelFor(readLabels.indexOf(read));
    assert.equal(outcome.writes, 0, `${read}: a failed exclusion read inserts nothing`);
  }
  const dismissal = await labelFor(readLabels.indexOf("sync.open_and_dismissed_opportunities"));
  assert.equal(dismissal.writes, 0);
  assert.equal(dismissal.opportunities.filter((row) => row.type === "no_show" && row.status === "open").length, 0, "the dismissed no-show is not re-opened");
  const enabled = await labelFor(readLabels.indexOf("automation_settings.enabled (instant-lead-followup)"));
  assert.equal(enabled.writes, 0, "a failed automation-enabled read no longer counts as enabled");
  const lostLookup = await labelFor(readLabels.indexOf("sync.resolved_lead_statuses"));
  assert.equal(lostLookup.writes, 0, "a failed lost-lead lookup no longer resolves as condition_no_longer_true");
  assert.equal(lostLookup.opportunities.find((row) => row.id === "opp-gone")!.status, "open");
});

test("a network-level failure (postgrest-js's FetchError shape) aborts exactly like a PostgREST error", async () => {
  const tables = fixture();
  const before = snapshot(tables);
  const fake = makeFakeSupabase(tables, { failSelectAt: 5, error: { message: "TypeError: fetch failed", details: "", hint: "", code: "" } });
  const result = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(result.failed, true);
  assert.deepEqual(fake.writes(), []);
  assert.equal(snapshot(fake.tables), before);
  assert.equal((abortLogs()[0][1] as { error: string }).error, "TypeError: fetch failed");
});

test("only read failures are converted: any other exception still propagates exactly as before (caught by the after() task, never by the sync)", async () => {
  const fake = makeFakeSupabase(fixture(), { throwOnTable: "no_such_table_used" });
  await syncOpportunities(fake.client, ORG, NOW); // sanity: no throw when nothing is wrong
  const broken = makeFakeSupabase(fixture(), { throwOnTable: "invoices" });
  await assert.rejects(syncOpportunities(broken.client, ORG, NOW), /unexpected client bug/);
  assert.deepEqual(broken.writes(), []);
  assert.equal(abortLogs().length, 0);
});

test("detectAllOpportunityCandidates rejects on a failed read instead of silently returning fewer candidates", async () => {
  const fake = makeFakeSupabase(fixture(), { failSelectAt: 0 });
  await assert.rejects(detectAllOpportunityCandidates(fake.client, ORG, NOW), (error: Error) => error.name === "OpportunityReadError");
});

test("background path: an aborted sync is logged inside the after() task and never reaches the page - scheduleOpportunitySync resolves before the sync runs", async () => {
  const tasks: (() => Promise<void>)[] = [];
  const failing = makeFakeSupabase(fixture(), { failSelectAt: 3 });
  const requestSupabase = { auth: { getSession: async () => ({ data: { session: { access_token: "token-for-test" } } }) } } as unknown as SupabaseClient;
  // Performance Pass 2: the task claims first - this organization wins its claim, so the (failing) sync runs.
  const client = Object.assign(failing.client, { rpc: async () => ({ data: true, error: null }) }) as unknown as SupabaseClient;
  await scheduleOpportunitySync(requestSupabase, ORG, { after: (task) => void tasks.push(task), createClient: () => client });
  assert.equal(tasks.length, 1, "scheduled, not run");
  assert.equal(failing.calls.length, 0, "nothing ran before after() fired");
  await tasks[0]();
  assert.equal(abortLogs().length, 1);
  assert.equal(logged.filter((args) => args[0] === "[opportunities] background sync failed").length, 0, "an abort is a normal result, not a thrown failure");
  assert.deepEqual(failing.writes(), []);
});

test("structural: every read in detect.ts goes through checked() - no `{ data } = await`, no `res.data ??`, and the three shared helpers are no longer called from the sync path", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /const \{ data(: \w+)? \} = await/, "no unchecked destructured read");
  assert.doesNotMatch(source, /\[\{ data/, "no unchecked destructured Promise.all read");
  assert.doesNotMatch(source, /res\.data \?\?/, "no unchecked .then read");
  assert.doesNotMatch(source, /\b(getAutomationEnabled|getAutomationConfigByOrganization|getOrganizationTimezone)\(/, "shared helpers that swallow errors are not used here");
  // Every awaited Supabase read sits inside checked(...), or is a write whose error is already observed.
  const reads = [...source.matchAll(/await supabase\s*\.from\("(\w+)"\)\s*\.select\(/g)].length;
  const readsInsideChecked = [...source.matchAll(/checked\(\s*[`"][^`"]+[`"],\s*await supabase\s*\.from\("(\w+)"\)\s*\.select\(/g)].length;
  assert.equal(readsInsideChecked, reads, "every directly awaited read is wrapped");
  assert.match(source, /catch \(error\) \{\s*return abortOnReadError\(organizationId, error\);\s*\}/, "the sync's read phase aborts through the one guard");
});
