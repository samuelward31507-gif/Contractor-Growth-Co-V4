/**
 * Phase 2H: Today's opportunity detection and sync at scale, against a fake
 * Supabase client that emulates filters, the API's 1,000-row response cap,
 * paging (range), the
 * conversations -> messages inner join and the opportunities -> contacts
 * join. Covers every detector past the API's 1,000-row cap and past the
 * ~400-id point where an id-list read failed; a failed page or the row
 * limit aborting the sync with no writes; no false resolutions; dismissals
 * older than the first 1,000 rows still suppressing re-creation; chunked,
 * counted resolutions; organization isolation; and Today's contact details
 * and 500-row display limit. The same scenarios run against TEST in
 * detect.scale.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.scale.test.ts
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { syncOpportunities, detectAllOpportunityCandidates }: typeof import("./detect") = require("./detect.ts");
const { getPrioritizedOpportunities }: typeof import("./intelligence") = require("./intelligence.ts");
const { MAX_ATTRIBUTION_ROWS }: typeof import("@/lib/bi/revenue-attribution") = require(path.join(process.cwd(), "lib/bi/revenue-attribution.ts"));

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "neq" | "in" | "not" | "lte" | "gte" | "lt" | "is"; column: string; value: unknown };
type Call = { table: string; op: string; columns: string; filters: Filter[]; page: [number, number] | null; failed: boolean };

/** Emulates the reads and writes detect.ts / intelligence.ts issue. `fail` decides, per call, whether it errors. */
function makeFake(tables: Record<string, Row[]>, fail: (call: Call) => boolean = () => false) {
  const calls: Call[] = [];
  function builder(table: string) {
    const filters: Filter[] = [];
    let op = "select";
    let payload: unknown;
    let maybe = false;
    let columns = "";
    let page: [number, number] | null = null;
    const matches = (row: Row) =>
      filters.every(({ kind, column, value }) => {
        if (column.includes(".")) return true; // embedded-resource filters are emulated per join below
        const actual = row[column];
        if (kind === "eq") return actual === value;
        if (kind === "neq") return actual !== value;
        if (kind === "in") return (value as unknown[]).includes(actual);
        if (kind === "is") return actual === value;
        if (kind === "not") return actual != null;
        if (kind === "lte") return String(actual) <= String(value);
        if (kind === "gte") return String(actual) >= String(value);
        return String(actual) < String(value);
      });
    function execute() {
      const rows = (tables[table] ??= []);
      const call: Call = { table, op, columns, filters: [...filters], page, failed: false };
      call.failed = fail(call);
      calls.push(call);
      if (call.failed) return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
      let result: Row[] = [];
      if (op === "select") {
        result = rows.filter(matches);
        if (table === "conversations" && columns.includes("messages!inner")) {
          const qualifying = (m: Row, c: Row) => m.conversation_id === c.id && m.organization_id === c.organization_id && (m.direction === "inbound" || (m.direction === "outbound" && ["sent", "delivered"].includes(String(m.status))));
          result = result.filter((c) => (tables.messages ?? []).some((m) => qualifying(m, c))).map((c) => ({ ...c, messages: [{ id: "m" }] }));
        }
        if (table === "opportunities" && columns.includes("contact:contacts")) {
          result = result.map((o) => ({ contact: (tables.contacts ?? []).find((c) => c.id === o.contact_id) ?? null }));
        }
        // Like the real API: a response carries at most 1,000 rows - a paged read asks for them by range.
        result = page ? result.slice(page[0], page[1] + 1) : result.slice(0, 1000);
      } else if (op === "insert") {
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
      or: () => b,
      order: () => b,
      limit: () => b,
      range: (from: number, to: number) => ((page = [from, to]), b),
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
  return { client: { from: builder, rpc: async () => ({ data: null, error: null }) } as unknown as SupabaseClient, calls, tables, writes };
}

const ORG = "org-a";
const OTHER = "org-b";
const NOW = new Date("2026-10-20T15:00:00.000Z");
const DAYS_AGO = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const contact = (org: string, i: number) => ({ id: `${org}-c${i}`, organization_id: org, first_name: `F${i}`, last_name: "L", company_name: null, phone: `+1555000${String(i).padStart(4, "0")}`, sms_opt_out: false });

/** An organization with `n` of every kind of record each detector reads - well past ~400 ids and, for n >= 1,200, past 1,000 rows. */
function scaleFixture(n: number, org = ORG): Record<string, Row[]> {
  const contacts = range(n).map((i) => contact(org, i));
  const c = (i: number) => contacts[i];
  return {
    organizations: [{ id: org, timezone: "America/Denver", review_url: "https://g.page/r/example", automation_mode: "live", payment_status: "active", automation_paused: false }],
    automation_settings: [],
    contacts,
    leads: [
      ...range(n).map((i) => ({ id: `${org}-q${i}`, organization_id: org, contact_id: c(i).id, status: "qualified", service: "Roof", estimated_value: null, temperature: "warm", created_at: DAYS_AGO(5), contacts: c(i) })),
      ...range(n).map((i) => ({ id: `${org}-n${i}`, organization_id: org, contact_id: c(i).id, status: "new", service: "Gutters", estimated_value: null, temperature: "cold", created_at: DAYS_AGO(3), contacts: c(i) })),
    ],
    appointments: [
      // Qualified leads 0..n/2 booked; every lead also has a completed visit (the "n" lead) - n/2 of them with an estimate.
      ...range(n / 2).map((i) => ({ id: `${org}-ab${i}`, organization_id: org, contact_id: c(i).id, lead_id: `${org}-q${i}`, title: "Visit", status: "scheduled", start_at: DAYS_AGO(-3), updated_at: DAYS_AGO(1), contacts: c(i) })),
      ...range(n).map((i) => ({ id: `${org}-av${i}`, organization_id: org, contact_id: c(i).id, lead_id: `${org}-n${i}`, title: "Visit", status: "completed", start_at: DAYS_AGO(9), updated_at: DAYS_AGO(9), contacts: c(i) })),
    ],
    estimates: [
      ...range(n / 2).map((i) => ({ id: `${org}-ev${i}`, organization_id: org, contact_id: c(i).id, lead_id: `${org}-n${i}`, title: "Quote", amount: 100, status: "draft", contacts: c(i) })),
      ...range(n).map((i) => ({ id: `${org}-ea${i}`, organization_id: org, contact_id: c(i).id, lead_id: null, title: "Accepted", amount: 900, status: "accepted", responded_at: DAYS_AGO(3), contacts: c(i) })),
    ],
    jobs: [
      // Old completed jobs - dormant customers, and completed jobs without review/referral requests.
      ...range(n).map((i) => ({ id: `${org}-j${i}`, organization_id: org, contact_id: c(i).id, title: "Old job", amount: 500, status: "completed", completed_at: DAYS_AGO(400), created_at: DAYS_AGO(410), estimate_id: null, contacts: c(i) })),
      // Jobs made from half the accepted estimates.
      ...range(n / 2).map((i) => ({ id: `${org}-je${i}`, organization_id: org, contact_id: null, title: "From estimate", amount: 900, status: "scheduled", completed_at: null, created_at: DAYS_AGO(2), estimate_id: `${org}-ea${i}`, contacts: null })),
    ],
    conversations: range(n).map((i) => ({ id: `${org}-conv${i}`, organization_id: org, contact_id: c(i).id })),
    messages: [
      // Contacts 0..n/2 contacted (inbound, or outbound delivered); the rest only have failed sends.
      ...range(n / 2).map((i) => ({ id: `${org}-m${i}`, organization_id: org, conversation_id: `${org}-conv${i}`, direction: i % 2 ? "inbound" : "outbound", status: i % 2 ? "received" : "delivered" })),
      ...range(n / 2).map((i) => ({ id: `${org}-mf${i}`, organization_id: org, conversation_id: `${org}-conv${n / 2 + i}`, direction: "outbound", status: "failed" })),
    ],
    referral_requests: range(n / 2).map((i) => ({ id: `${org}-rr${i}`, organization_id: org, job_id: `${org}-j${i}`, status: "sent" })),
    review_requests: range(n / 2).map((i) => ({ id: `${org}-rv${i}`, organization_id: org, job_id: `${org}-j${i}`, status: "sent" })),
    invoices: [],
    opportunities: [],
  };
}

const byType = (candidates: { type: string }[]) => candidates.reduce<Record<string, number>>((acc, c) => ((acc[c.type] = (acc[c.type] ?? 0) + 1), acc), {});
const ID_LIST_COLUMNS = new Set(["id", "lead_id", "contact_id", "conversation_id", "job_id", "estimate_id", "entity_id"]);

let logged: unknown[][] = [];
const realConsoleError = console.error;
beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => void logged.push(args);
});
afterEach(() => {
  console.error = realConsoleError;
});

test("every detector is complete past 1,000 rows and ~400 ids: 1,200 of each record, exact candidate counts per type, no id list in any read", async () => {
  const n = 1200;
  const fake = makeFake(scaleFixture(n));
  const counts = byType(await detectAllOpportunityCandidates(fake.client, ORG, NOW));
  assert.deepEqual(counts, {
    qualified_lead_unbooked: n / 2, // half the qualified leads are booked
    completed_appointment_no_estimate: n / 2, // half the visited leads have an estimate
    completed_job_no_referral_request: n / 2,
    completed_job_no_review_request: n / 2,
    uncontacted_lead: n / 2, // failed sends don't count as contact
    accepted_estimate_no_job: n / 2,
    // dormant_customer: every contact has an open lead, so none is dormant here - covered separately below
  });
  const reads = fake.calls.filter((call) => call.op === "select");
  for (const call of reads) {
    const idList = call.filters.find((f) => f.kind === "in" && ID_LIST_COLUMNS.has(f.column));
    assert.equal(idList, undefined, `${call.table} read sends an id list: ${JSON.stringify(idList)}`);
  }
  assert.ok(reads.some((call) => call.page?.[0] === 1000), "reads continued to a second page");
});

test("dormant customers: 450 due contacts (past ~400) with no open activity, names from the jobs join - and contacts with an open lead, appointment, estimate or job are excluded", async () => {
  const tables = scaleFixture(450);
  tables.leads = []; // no open leads...
  tables.appointments = tables.appointments.filter((row) => row.status !== "scheduled");
  // ...except these exclusions, one per kind of active record
  tables.leads.push({ id: "x-lead", organization_id: ORG, contact_id: `${ORG}-c0`, status: "contacted", temperature: "warm", created_at: DAYS_AGO(1) });
  tables.appointments.push({ id: "x-appt", organization_id: ORG, contact_id: `${ORG}-c1`, lead_id: null, title: "Visit", status: "confirmed", start_at: DAYS_AGO(-2), updated_at: DAYS_AGO(1) });
  tables.estimates = tables.estimates.filter((row) => row.status !== "accepted");
  tables.estimates.push({ id: "x-est", organization_id: ORG, contact_id: `${ORG}-c2`, lead_id: null, title: "Q", amount: 1, status: "sent" });
  tables.jobs = tables.jobs.filter((row) => row.status === "completed");
  tables.jobs.push({ id: "x-job", organization_id: ORG, contact_id: `${ORG}-c3`, title: "Active", amount: 1, status: "in_progress", completed_at: null, created_at: DAYS_AGO(1), estimate_id: null, contacts: null });
  const fake = makeFake(tables);
  const dormant = (await detectAllOpportunityCandidates(fake.client, ORG, NOW)).filter((c) => c.type === "dormant_customer");
  assert.equal(dormant.length, 446);
  assert.ok(!dormant.some((c) => [`${ORG}-c0`, `${ORG}-c1`, `${ORG}-c2`, `${ORG}-c3`].includes(c.sourceEntityId)));
  assert.equal(dormant.find((c) => c.sourceEntityId === `${ORG}-c10`)!.title, "F10 L");
  assert.ok(!fake.calls.some((call) => call.table === "contacts"), "no separate contacts read - names come from the jobs join");
});

test("a failure on page 2 of any read aborts the whole sync: zero writes, every opportunity untouched, the read named in the log", async () => {
  const base = scaleFixture(1200);
  base.opportunities = range(30).map((i) => ({ id: `opp-${i}`, organization_id: ORG, type: "stale_estimate", source_entity_type: "estimate", source_entity_id: `gone-${i}`, status: "open", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(30) }));
  const baseline = makeFake(structuredClone(base));
  await syncOpportunities(baseline.client, ORG, NOW);
  const pagedTables = [...new Set(baseline.calls.filter((call) => call.op === "select" && call.page?.[0] === 1000).map((call) => `${call.table}|${call.columns}`))];
  assert.ok(pagedTables.length >= 8, pagedTables.join("\n"));
  for (const key of pagedTables) {
    logged = [];
    const tables = structuredClone(base);
    const before = JSON.stringify(tables.opportunities);
    const fake = makeFake(tables, (call) => call.op === "select" && `${call.table}|${call.columns}` === key && call.page?.[0] === 1000);
    const result = await syncOpportunities(fake.client, ORG, NOW);
    assert.equal(result.failed, true, key);
    assert.deepEqual(fake.writes(), [], `${key}: no write after a failed page`);
    assert.equal(JSON.stringify(fake.tables.opportunities), before);
    assert.equal(logged.filter((args) => args[0] === "[opportunities] sync aborted: read failed").length, 1);
  }
});

test("reaching the row limit aborts the sync rather than resolving from a partial read", async () => {
  const tables = scaleFixture(4);
  tables.estimates.push(...range(MAX_ATTRIBUTION_ROWS + 1).map((i) => ({ id: `big-${i}`, organization_id: ORG, contact_id: null, lead_id: null, title: "Old", amount: 1, status: "expired" })));
  tables.opportunities = [{ id: "opp-1", organization_id: ORG, type: "stale_estimate", source_entity_type: "estimate", source_entity_id: "big-5", status: "open", title: "t", description: null, estimated_value: 1, value_basis: "estimates.amount", metadata: {}, created_at: DAYS_AGO(1) }];
  const fake = makeFake(tables);
  const result = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(result.failed, true);
  assert.deepEqual(fake.writes(), []);
  assert.equal(fake.tables.opportunities[0].status, "open");
  assert.equal((logged.find((args) => args[0] === "[opportunities] sync aborted: read failed")![1] as { error: string }).error, "the row limit was reached");
});

test("no false resolutions: 1,500 open opportunities whose conditions still hold all stay open across two syncs", async () => {
  const tables = scaleFixture(2);
  tables.estimates.push(...range(1500).map((i) => ({ id: `exp-${i}`, organization_id: ORG, contact_id: null, lead_id: null, title: "Paint", amount: 10, status: "expired", sent_at: null, expires_at: null, contacts: null })));
  const fake = makeFake(tables);
  const first = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(first.created >= 1500, true, JSON.stringify(first));
  const second = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(second.resolved, 0, JSON.stringify(second));
  assert.equal(fake.tables.opportunities.filter((row) => row.type === "stale_estimate" && row.status === "open").length, 1500);
});

test("dismissals past the first 1,000 rows still suppress re-creation (newest-first, complete)", async () => {
  const tables = scaleFixture(2);
  tables.appointments.push(...range(1200).map((i) => ({ id: `ns-${i}`, organization_id: ORG, contact_id: null, lead_id: null, title: "Missed", status: "no_show", start_at: DAYS_AGO(5), updated_at: DAYS_AGO(5), contacts: null })));
  // 1,200 old dismissals, plus 300 newer open rows of another type ahead of them in newest-first order.
  tables.opportunities = [
    ...range(1200).map((i) => ({ id: `d-${i}`, organization_id: ORG, type: "no_show", source_entity_type: "appointment", source_entity_id: `ns-${i}`, status: "dismissed", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(60) })),
    ...range(300).map((i) => ({ id: `o-${i}`, organization_id: ORG, type: "stale_estimate", source_entity_type: "estimate", source_entity_id: `none-${i}`, status: "open", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(1) })),
  ];
  const fake = makeFake(tables);
  const result = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(result.failed, undefined);
  assert.equal(fake.tables.opportunities.filter((row) => row.type === "no_show" && row.status === "open").length, 0, "no dismissed no-show re-created");
  assert.ok(result.suppressed >= 1200, JSON.stringify(result));
});

test("resolutions: 450 open lead opportunities resolve in chunks of at most 200 ids, counted by rows actually changed, lost leads as 'lost' - semantics unchanged", async () => {
  const tables = scaleFixture(2);
  tables.leads.push(...range(450).map((i) => ({ id: `gone-${i}`, organization_id: ORG, contact_id: null, status: i < 150 ? "lost" : "won", temperature: "warm", created_at: DAYS_AGO(20) })));
  tables.opportunities = range(450).map((i) => ({ id: `opp-${i}`, organization_id: ORG, type: "qualified_lead_unbooked", source_entity_type: "lead", source_entity_id: `gone-${i}`, status: "open", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(10) }));
  const fake = makeFake(tables);
  const result = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(result.resolved, 450);
  const updates = fake.calls.filter((call) => call.op === "update" && call.table === "opportunities" && call.filters.some((f) => f.kind === "in" && f.column === "id"));
  assert.ok(updates.length >= 3 && updates.every((call) => (call.filters.find((f) => f.kind === "in")!.value as unknown[]).length <= 200), "chunked");
  const resolved = fake.tables.opportunities.filter((row) => String(row.id).startsWith("opp-"));
  assert.equal(resolved.filter((row) => row.resolution_reason === "lost").length, 150);
  assert.equal(resolved.filter((row) => row.resolution_reason === "condition_no_longer_true").length, 300);
  assert.ok(!fake.calls.some((call) => call.op === "select" && call.table === "leads" && call.filters.some((f) => f.kind === "in" && f.column === "id")), "lost-lead lookup has no id list");
});

test("a failed resolve chunk is logged and not counted - never reported as resolved", async () => {
  const tables = scaleFixture(2);
  tables.opportunities = range(450).map((i) => ({ id: `opp-${i}`, organization_id: ORG, type: "stale_estimate", source_entity_type: "estimate", source_entity_id: `gone-${i}`, status: "open", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(10) }));
  let updates = 0;
  const fake = makeFake(tables, (call) => call.op === "update" && call.table === "opportunities" && ++updates === 2);
  const result = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(result.resolved, 250, "200 + 50 - the failed middle chunk of 200 isn't counted");
  assert.equal(logged.filter((args) => args[0] === "[opportunities] failed to resolve opportunities").length, 1);
});

test("organization isolation: another organization's records never become candidates, and its conversations never mark a contact as contacted", async () => {
  const tables = scaleFixture(450);
  const other = scaleFixture(450, OTHER);
  for (const [table, rows] of Object.entries(other)) tables[table] = [...(tables[table] ?? []), ...rows];
  const candidates = await detectAllOpportunityCandidates(makeFake(tables).client, ORG, NOW);
  assert.ok(candidates.every((c) => !c.sourceEntityId.startsWith(OTHER)));
  assert.equal(byType(candidates).uncontacted_lead, 225);
});

test("Today's prioritized opportunities: contact details for 450 opportunities with no contact id list; the open-opportunities read is paged newest first (Phase 3A-4 removed the 500 cap)", async () => {
  const tables = scaleFixture(450);
  tables.opportunities = range(450).map((i) => ({ id: `opp-${i}`, organization_id: ORG, type: "stale_estimate", source_entity_type: "estimate", source_entity_id: `e-${i}`, contact_id: `${ORG}-c${i}`, status: "open", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(1), resolved_at: null, resolution_reason: null }));
  const fake = makeFake(tables);
  const prioritized = await getPrioritizedOpportunities(fake.client, ORG, NOW);
  assert.equal(prioritized.length, 450);
  assert.ok(prioritized.every((p) => p.contactPhone !== null), "every contact's phone found");
  assert.ok(!fake.calls.some((call) => call.table === "contacts" && call.filters.some((f) => f.kind === "in")), "no contact id list");
  const queriesSource = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/queries.ts"), "utf8");
  assert.match(queriesSource, /readAllPages<OpportunityRow>\(\(\) =>\s*supabase\.from\("opportunities"\)\.select\(OPPORTUNITY_COLUMNS\)\.eq\("organization_id", organizationId\)\.eq\("status", "open"\)\.order\("created_at", \{ ascending: false \}\)\.order\("id"\)/, "every open opportunity, paged newest first (Phase 3A-4)");
});

test("structural: detect.ts has no capped read and no id-list read left; every paged read goes through checkedAll", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /MAX_ROWS/);
  assert.doesNotMatch(source, /\.limit\((?!1, \{ referencedTable: "messages" \})/, "the only .limit is the one-message evidence limit inside the join");
  const idLists = [...source.matchAll(/\.in\("(id|lead_id|contact_id|conversation_id|job_id|estimate_id)"/g)].map((m) => m[1]);
  assert.deepEqual(idLists, ["id"], "only the chunked resolve update names ids");
  assert.match(source, /for \(let i = 0; i < rows\.length; i \+= RESOLVE_CHUNK\)/);
  assert.equal([...source.matchAll(/checkedAll(<[^>]+>)?\(\s*"/g)].length >= 24, true);
});
