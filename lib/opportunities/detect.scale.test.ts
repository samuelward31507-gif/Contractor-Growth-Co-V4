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
          // Phase 2-5: like the real read (ordered newest first, limit 1 per conversation), the one embedded message is the conversation's newest evidence.
          const newest = (c: Row) => (tables.messages ?? []).filter((m) => qualifying(m, c)).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
          result = result.filter((c) => newest(c) !== undefined).map((c) => ({ ...c, messages: [{ created_at: newest(c)!.created_at, direction: newest(c)!.direction }] }));
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
      ...range(n / 2).map((i) => ({ id: `${org}-m${i}`, organization_id: org, conversation_id: `${org}-conv${i}`, direction: i % 2 ? "inbound" : "outbound", status: i % 2 ? "received" : "delivered", created_at: DAYS_AGO(2) })),
      ...range(n / 2).map((i) => ({ id: `${org}-mf${i}`, organization_id: org, conversation_id: `${org}-conv${n / 2 + i}`, direction: "outbound", status: "failed", created_at: DAYS_AGO(2) })),
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

// ---------------------------------------------------------------------------
// Phase 2-5: uncontacted leads are human work - independent of automation
// state and SMS opt-out (Phase 2 definition), evidence only counts from the
// lead's creation on (L1, with B3's waiting-for-reply exception), and the
// onboarding test lead is never a candidate (L2).
// ---------------------------------------------------------------------------

const LEAD_CREATED = DAYS_AGO(3);

/** One organization, one contact, one 'new' lead created three days ago, plus whatever conversations and messages a test adds. */
function uncontactedFixture(organization: Row = {}, contactOverrides: Row = {}, leadOverrides: Row = {}): Record<string, Row[]> {
  const tables = scaleFixture(0);
  tables.organizations = [{ ...tables.organizations[0], ...organization }];
  const person = { ...contact(ORG, 1), ...contactOverrides };
  tables.contacts = [person];
  tables.leads = [{ id: "lead-1", organization_id: ORG, contact_id: person.id, status: "new", service: "Roof", source: "website", estimated_value: null, temperature: "warm", created_at: LEAD_CREATED, contacts: person, ...leadOverrides }];
  return tables;
}

function addMessage(tables: Record<string, Row[]>, conversation: { id: string; status?: string }, message: { direction: "inbound" | "outbound"; status: string; created_at: string }) {
  if (!tables.conversations.some((row) => row.id === conversation.id)) tables.conversations.push({ id: conversation.id, organization_id: ORG, contact_id: `${ORG}-c1`, status: conversation.status ?? "open" });
  tables.messages.push({ id: `msg-${tables.messages.length}`, organization_id: ORG, conversation_id: conversation.id, ...message });
}

async function uncontactedIds(tables: Record<string, Row[]>) {
  const fake = makeFake(tables);
  const candidates = await detectAllOpportunityCandidates(fake.client, ORG, NOW);
  return { ids: candidates.filter((c) => c.type === "uncontacted_lead").map((c) => c.sourceEntityId), calls: fake.calls };
}

test("Phase 2-5: an uncontacted lead is a candidate whatever the automation state - test mode, paused, unpaid, or instant-lead-followup disabled", async () => {
  const variants: [string, Record<string, Row[]>][] = [
    ["live and eligible", uncontactedFixture()],
    ["test mode", uncontactedFixture({ automation_mode: "test" })],
    ["paused", uncontactedFixture({ automation_paused: true })],
    ["payment not active", uncontactedFixture({ payment_status: "payment_required" })],
    ["no organization row", { ...uncontactedFixture(), organizations: [] }],
  ];
  const disabled = uncontactedFixture();
  disabled.automation_settings = [{ id: "s1", organization_id: ORG, automation_id: "instant-lead-followup", enabled: false, config: {} }];
  variants.push(["instant-lead-followup disabled", disabled]);
  for (const [label, tables] of variants) {
    const { ids, calls } = await uncontactedIds(tables);
    assert.deepEqual(ids, ["lead-1"], label);
    assert.ok(!calls.some((call) => call.table === "automation_settings" && call.filters.some((f) => f.value === "instant-lead-followup")), `${label}: instant-lead-followup's setting is never read`);
  }
});

test("Phase 2-5: an opted-out contact's lead is kept - opt-out blocks texting, not calling", async () => {
  assert.deepEqual((await uncontactedIds(uncontactedFixture({}, { sms_opt_out: true }))).ids, ["lead-1"]);
});

test("Phase 2-5 (L1): only evidence from the lead's creation on counts", async () => {
  const before = DAYS_AGO(10);
  const after = DAYS_AGO(2);

  const oldOutbound = uncontactedFixture();
  addMessage(oldOutbound, { id: "conv-1" }, { direction: "outbound", status: "delivered", created_at: before });
  assert.deepEqual((await uncontactedIds(oldOutbound)).ids, ["lead-1"], "a delivered message from before the lead was created");

  const newOutbound = uncontactedFixture();
  addMessage(newOutbound, { id: "conv-1" }, { direction: "outbound", status: "delivered", created_at: before });
  addMessage(newOutbound, { id: "conv-1" }, { direction: "outbound", status: "sent", created_at: after });
  assert.deepEqual((await uncontactedIds(newOutbound)).ids, [], "a sent message after the lead was created");

  const atCreation = uncontactedFixture();
  addMessage(atCreation, { id: "conv-1" }, { direction: "outbound", status: "delivered", created_at: LEAD_CREATED });
  assert.deepEqual((await uncontactedIds(atCreation)).ids, [], "evidence at exactly the lead's created_at counts");

  const newInbound = uncontactedFixture();
  addMessage(newInbound, { id: "conv-1", status: "closed" }, { direction: "inbound", status: "received", created_at: after });
  assert.deepEqual((await uncontactedIds(newInbound)).ids, [], "an inbound message after the lead was created");

  const failedAfter = uncontactedFixture();
  addMessage(failedAfter, { id: "conv-1" }, { direction: "outbound", status: "delivered", created_at: before });
  addMessage(failedAfter, { id: "conv-1" }, { direction: "outbound", status: "failed", created_at: after });
  assert.deepEqual((await uncontactedIds(failedAfter)).ids, ["lead-1"], "a failed send after creation is still not contact");

  const otherConversation = uncontactedFixture();
  addMessage(otherConversation, { id: "conv-old", status: "closed" }, { direction: "outbound", status: "delivered", created_at: before });
  addMessage(otherConversation, { id: "conv-new", status: "closed" }, { direction: "outbound", status: "delivered", created_at: after });
  assert.deepEqual((await uncontactedIds(otherConversation)).ids, [], "the newest evidence across all of the contact's conversations");
});

test("Phase 2-5 (L1 with B3): an open conversation still waiting on the customer's earlier message wins over uncontacted; once answered before the lead existed, it no longer does", async () => {
  const waiting = uncontactedFixture();
  addMessage(waiting, { id: "conv-1", status: "open" }, { direction: "inbound", status: "received", created_at: DAYS_AGO(10) });
  assert.deepEqual((await uncontactedIds(waiting)).ids, [], "unanswered inbound in an open conversation - waiting for reply wins");

  const closedWaiting = uncontactedFixture();
  addMessage(closedWaiting, { id: "conv-1", status: "closed" }, { direction: "inbound", status: "received", created_at: DAYS_AGO(10) });
  assert.deepEqual((await uncontactedIds(closedWaiting)).ids, ["lead-1"], "a closed conversation is not waiting - old evidence does not count");

  const answered = uncontactedFixture();
  addMessage(answered, { id: "conv-1", status: "open" }, { direction: "inbound", status: "received", created_at: DAYS_AGO(10) });
  addMessage(answered, { id: "conv-1", status: "open" }, { direction: "outbound", status: "delivered", created_at: DAYS_AGO(9) });
  assert.deepEqual((await uncontactedIds(answered)).ids, ["lead-1"], "answered before the lead was created - uncontacted again");
});

test("Phase 2-5 (L2): the onboarding test lead is never a candidate; a real lead for the same contact still is", async () => {
  const tables = uncontactedFixture({}, {}, { source: "onboarding_test" });
  assert.deepEqual((await uncontactedIds(tables)).ids, []);
  tables.leads.push({ ...tables.leads[0], id: "lead-2", source: null });
  assert.deepEqual((await uncontactedIds(tables)).ids, ["lead-2"], "a null source is a real lead");
});

test("Phase 2-5 structural: the uncontacted-lead detector reads no organization or automation state and imports the onboarding source constant", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8");
  const start = source.indexOf("async function detectUncontactedLeads(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.doesNotMatch(body, /from\("organizations"\)|automation_settings|automation_mode|payment_status|automation_paused|sms_opt_out/);
  assert.match(body, /lead\.source !== ONBOARDING_TEST_LEAD_SOURCE/);
  assert.match(source, /import \{ ONBOARDING_TEST_LEAD_SOURCE \} from "@\/lib\/onboarding\/readiness";/);
  assert.doesNotMatch(source, /readAutomationEnabled|INSTANT_LEAD_FOLLOWUP_AUTOMATION_ID/);
});

// ---------------------------------------------------------------------------
// Phase 2-6: pending estimates are keyed to the estimate (A1, A13), no lead
// or contact required; the same-lead dedup reads metadata.lead_id (B8); and
// an old lead-keyed dismissal carries forward to the estimate-keyed
// candidates of that lead (B1).
// ---------------------------------------------------------------------------

const { opportunityActionHref }: typeof import("@/lib/decisions/registry") = require(path.join(process.cwd(), "lib/decisions/registry.ts"));

const SENT_AT = DAYS_AGO(2);

/** One organization with two contacts and nothing else; tests add leads, estimates and opportunities. */
function estimateFixture(): Record<string, Row[]> {
  const tables = scaleFixture(0);
  tables.contacts = [contact(ORG, 1), contact(ORG, 2)];
  tables.opportunities = [];
  return tables;
}

function sentEstimate(id: string, overrides: Row = {}): Row {
  const person = overrides.contact_id === null ? null : (estimateFixture().contacts.find((c) => c.id === (overrides.contact_id ?? `${ORG}-c1`)) ?? null);
  return { id, organization_id: ORG, contact_id: `${ORG}-c1`, lead_id: null, title: `Quote ${id}`, amount: 1200, status: "sent", sent_at: SENT_AT, contacts: person, ...overrides };
}

const pendingOf = async (tables: Record<string, Row[]>) => (await detectAllOpportunityCandidates(makeFake(tables).client, ORG, NOW)).filter((c) => c.type === "pending_estimate");
const openPendingRows = (tables: Record<string, Row[]>) => tables.opportunities.filter((row) => row.type === "pending_estimate" && row.status === "open");

test("Phase 2-6: a sent estimate with no lead is a pending_estimate candidate keyed to the estimate, with estimate_id, sent_at and a null lead_id in metadata", async () => {
  const tables = estimateFixture();
  tables.estimates = [sentEstimate("est-1")];
  const [candidate, ...rest] = await pendingOf(tables);
  assert.equal(rest.length, 0);
  assert.equal(candidate.sourceEntityType, "estimate");
  assert.equal(candidate.sourceEntityId, "est-1");
  assert.equal(candidate.contactId, `${ORG}-c1`);
  assert.deepEqual(candidate.metadata, { estimate_id: "est-1", sent_at: SENT_AT, lead_id: null });
  assert.equal(candidate.title, "F1 L");
});

test("Phase 2-6: a sent estimate linked to a lead keeps the lead in metadata.lead_id; an estimate with no contact is still a candidate, titled by the estimate", async () => {
  const tables = estimateFixture();
  tables.leads = [{ id: "lead-1", organization_id: ORG, contact_id: `${ORG}-c1`, status: "estimate", service: "Roof", estimated_value: null, temperature: "warm", created_at: DAYS_AGO(5), contacts: tables.contacts[0] }];
  tables.estimates = [sentEstimate("est-lead", { lead_id: "lead-1" }), sentEstimate("est-nobody", { contact_id: null })];
  const byId = new Map((await pendingOf(tables)).map((c) => [c.sourceEntityId, c]));
  assert.deepEqual(byId.get("est-lead")!.metadata, { estimate_id: "est-lead", sent_at: SENT_AT, lead_id: "lead-1" });
  const nobody = byId.get("est-nobody")!;
  assert.equal(nobody.contactId, null);
  assert.equal(nobody.title, "Quote est-nobody");
  assert.deepEqual(nobody.metadata, { estimate_id: "est-nobody", sent_at: SENT_AT, lead_id: null });
});

test("Phase 2-6 (A13): two sent estimates on the same lead are two separate candidates - neither replaces the other", async () => {
  const tables = estimateFixture();
  tables.leads = [{ id: "lead-1", organization_id: ORG, contact_id: `${ORG}-c1`, status: "estimate", service: "Roof", estimated_value: null, temperature: "warm", created_at: DAYS_AGO(5), contacts: tables.contacts[0] }];
  tables.estimates = [sentEstimate("est-a", { lead_id: "lead-1" }), sentEstimate("est-b", { lead_id: "lead-1", amount: 3400 })];
  const candidates = await pendingOf(tables);
  assert.deepEqual(candidates.map((c) => c.sourceEntityId).sort(), ["est-a", "est-b"]);
  assert.deepEqual(candidates.map((c) => c.estimatedValue).sort(), [1200, 3400]);
  const result = await syncOpportunities(makeFake(tables).client, ORG, NOW);
  assert.equal(result.created >= 2, true);
  assert.deepEqual(openPendingRows(tables).map((row) => row.source_entity_id).sort(), ["est-a", "est-b"]);
});

test("Phase 2-6 (B8): the same-lead dedup works through metadata.lead_id - a lead with a more specific type suppresses its pending estimate, and a pending estimate suppresses that lead's active-lead signal", async () => {
  const tables = estimateFixture();
  tables.leads = [
    // Qualified and unbooked: qualified_lead_unbooked wins over its pending estimate.
    { id: "lead-q", organization_id: ORG, contact_id: `${ORG}-c1`, status: "qualified", service: "Roof", estimated_value: null, temperature: "warm", created_at: DAYS_AGO(5), contacts: tables.contacts[0] },
    // Hot: its pending estimate wins over active_lead_signal.
    { id: "lead-h", organization_id: ORG, contact_id: `${ORG}-c2`, status: "contacted", service: "Deck", estimated_value: null, temperature: "hot", created_at: DAYS_AGO(5), contacts: tables.contacts[1] },
  ];
  tables.estimates = [sentEstimate("est-q", { lead_id: "lead-q" }), sentEstimate("est-h", { lead_id: "lead-h", contact_id: `${ORG}-c2` })];
  const candidates = await detectAllOpportunityCandidates(makeFake(tables).client, ORG, NOW);
  const of = (type: string) => candidates.filter((c) => c.type === type).map((c) => c.sourceEntityId);
  assert.deepEqual(of("qualified_lead_unbooked"), ["lead-q"]);
  assert.deepEqual(of("pending_estimate"), ["est-h"], "the qualified lead's estimate is deduped; the hot lead's is kept");
  assert.deepEqual(of("active_lead_signal"), [], "the hot lead is covered by its pending estimate");
});

test("Phase 2-6: an estimate with no lead is never deduped against a lead-level type, even for a contact whose lead has one", async () => {
  const tables = estimateFixture();
  tables.leads = [
    { id: "lead-q", organization_id: ORG, contact_id: `${ORG}-c1`, status: "qualified", service: "Roof", estimated_value: null, temperature: "hot", created_at: DAYS_AGO(5), contacts: tables.contacts[0] },
  ];
  tables.estimates = [sentEstimate("est-free")];
  const candidates = await detectAllOpportunityCandidates(makeFake(tables).client, ORG, NOW);
  assert.ok(candidates.some((c) => c.type === "qualified_lead_unbooked" && c.sourceEntityId === "lead-q"));
  assert.ok(candidates.some((c) => c.type === "pending_estimate" && c.sourceEntityId === "est-free"), "same contact, but no lead - not deduped");
});

test("Phase 2-6 (B1): an old lead-keyed pending_estimate dismissal suppresses the estimate-keyed candidates of that lead; other estimates are created", async () => {
  const tables = estimateFixture();
  tables.leads = [{ id: "lead-1", organization_id: ORG, contact_id: `${ORG}-c1`, status: "estimate", service: "Roof", estimated_value: null, temperature: "warm", created_at: DAYS_AGO(5), contacts: tables.contacts[0] }];
  tables.estimates = [sentEstimate("est-a", { lead_id: "lead-1" }), sentEstimate("est-b", { lead_id: "lead-1" }), sentEstimate("est-free")];
  tables.opportunities = [{ id: "opp-old", organization_id: ORG, type: "pending_estimate", source_entity_type: "lead", source_entity_id: "lead-1", contact_id: `${ORG}-c1`, status: "dismissed", resolved_at: DAYS_AGO(3), resolution_reason: "dismissed", title: "t", description: null, estimated_value: null, value_basis: null, metadata: { estimate_id: "est-a", sent_at: SENT_AT }, created_at: DAYS_AGO(4) }];
  const result = await syncOpportunities(makeFake(tables).client, ORG, NOW);
  assert.equal(result.suppressed, 2, JSON.stringify(result));
  assert.deepEqual(openPendingRows(tables).map((row) => row.source_entity_id), ["est-free"]);
  assert.equal(tables.opportunities.find((row) => row.id === "opp-old")!.status, "dismissed", "the old dismissal itself is untouched");
});

test("Phase 2-6: an estimate-keyed dismissal suppresses that estimate; a second sync creates no duplicate", async () => {
  const tables = estimateFixture();
  tables.estimates = [sentEstimate("est-1"), sentEstimate("est-2")];
  const fake = makeFake(tables);
  const first = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(first.created, 2);
  const second = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(second.created, 0);
  assert.equal(openPendingRows(tables).length, 2, "one row per estimate, never a duplicate");

  Object.assign(tables.opportunities.find((row) => row.source_entity_id === "est-1")!, { status: "dismissed", resolution_reason: "dismissed" });
  const third = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(third.created, 0);
  assert.equal(third.suppressed, 1);
  assert.deepEqual(openPendingRows(tables).map((row) => row.source_entity_id), ["est-2"]);
});

test("Phase 2-6 (approved one-time churn): an open lead-keyed pending_estimate row resolves as condition_no_longer_true and the estimate-keyed row is created", async () => {
  const tables = estimateFixture();
  tables.leads = [{ id: "lead-1", organization_id: ORG, contact_id: `${ORG}-c1`, status: "estimate", service: "Roof", estimated_value: null, temperature: "warm", created_at: DAYS_AGO(5), contacts: tables.contacts[0] }];
  tables.estimates = [sentEstimate("est-a", { lead_id: "lead-1" })];
  tables.opportunities = [{ id: "opp-old", organization_id: ORG, type: "pending_estimate", source_entity_type: "lead", source_entity_id: "lead-1", contact_id: `${ORG}-c1`, status: "open", resolved_at: null, resolution_reason: null, title: "t", description: null, estimated_value: 1200, value_basis: "estimates.amount", metadata: { estimate_id: "est-a", sent_at: SENT_AT }, created_at: DAYS_AGO(4) }];
  const result = await syncOpportunities(makeFake(tables).client, ORG, NOW);
  assert.equal(result.resolved, 1);
  assert.equal(result.created, 1);
  const old = tables.opportunities.find((row) => row.id === "opp-old")!;
  assert.deepEqual([old.status, old.resolution_reason], ["resolved", "condition_no_longer_true"]);
  const [fresh] = openPendingRows(tables);
  assert.deepEqual([fresh.source_entity_type, fresh.source_entity_id], ["estimate", "est-a"]);
});

test("Phase 2-6: the synced estimate-keyed opportunity's link still resolves through metadata.estimate_id to /estimates/<id>", async () => {
  const tables = estimateFixture();
  tables.estimates = [sentEstimate("est-1"), sentEstimate("est-2", { contact_id: null })];
  const fake = makeFake(tables);
  await syncOpportunities(fake.client, ORG, NOW);
  const prioritized = await getPrioritizedOpportunities(fake.client, ORG, NOW);
  const hrefs = prioritized.filter((p) => p.opportunity.type === "pending_estimate").map((p) => [p.opportunity.sourceEntityId, (p.opportunity.metadata as Row).estimate_id, opportunityActionHref(p.opportunity)]);
  assert.deepEqual(hrefs.sort(), [
    ["est-1", "est-1", "/estimates/est-1"],
    ["est-2", "est-2", "/estimates/est-2"],
  ]);
});

test("Phase 2-6 structural: the pending-estimate read no longer requires a lead, and the dedup and B1 carry-forward read metadata.lead_id", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8");
  const start = source.indexOf("async function detectPendingEstimates(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.doesNotMatch(body, /\.not\("lead_id"/);
  assert.doesNotMatch(body, /\.not\("contact_id"/);
  assert.match(body, /sourceEntityType: "estimate" as const,\s*sourceEntityId: row\.id,/);
  assert.match(body, /metadata: \{ estimate_id: row\.id, sent_at: row\.sent_at, lead_id: row\.lead_id \}/);
  assert.match(source, /dismissedKeys\.has\(candidateKey\("pending_estimate", carriedLeadKey\)\)/);
});

// ---------------------------------------------------------------------------
// Phase 2-7: booking-gap A10 contact fallback. A qualified lead is booked by
// a scheduled/confirmed/completed appointment linked to it by lead_id, or by
// a lead-less appointment for its own contact starting at or after the lead
// was created. Cancelled and no-show never book (L5 keeps completed).
// ---------------------------------------------------------------------------

const QUALIFIED_CREATED = "2026-10-10T12:00:00.000Z";

/** One qualified lead (lead-q, contact c1, created QUALIFIED_CREATED), a second lead (lead-other) on the same contact, and a second contact c2. */
function bookingFixture(appointments: Row[]): Record<string, Row[]> {
  const tables = scaleFixture(0);
  const [c1, c2] = [contact(ORG, 1), contact(ORG, 2)];
  tables.contacts = [c1, c2];
  tables.leads = [
    { id: "lead-q", organization_id: ORG, contact_id: c1.id, status: "qualified", service: "Roof", estimated_value: null, temperature: "warm", created_at: QUALIFIED_CREATED, contacts: c1 },
    { id: "lead-other", organization_id: ORG, contact_id: c1.id, status: "won", service: "Gutters", estimated_value: null, temperature: "warm", created_at: "2026-01-01T00:00:00.000Z", contacts: c1 },
  ];
  tables.appointments = appointments.map((row, i) => ({ id: `appt-${i}`, organization_id: ORG, title: "Visit", updated_at: DAYS_AGO(1), contacts: c1, ...row }));
  return tables;
}

const appt = (status: string, startAt: string, overrides: Row = {}): Row => ({ status, start_at: startAt, lead_id: null, contact_id: `${ORG}-c1`, ...overrides });

async function isBookingGap(appointments: Row[]): Promise<boolean> {
  const candidates = await detectAllOpportunityCandidates(makeFake(bookingFixture(appointments)).client, ORG, NOW);
  return candidates.some((c) => c.type === "qualified_lead_unbooked" && c.sourceEntityId === "lead-q");
}

const AFTER = "2026-10-15T09:00:00.000Z";
const BEFORE = "2026-09-01T09:00:00.000Z";

test("Phase 2-7: an appointment linked to the lead by lead_id books it when scheduled, confirmed or completed - not when cancelled or a no-show", async () => {
  for (const status of ["scheduled", "confirmed", "completed"]) assert.equal(await isBookingGap([appt(status, AFTER, { lead_id: "lead-q" })]), false, status);
  for (const status of ["cancelled", "no_show"]) assert.equal(await isBookingGap([appt(status, AFTER, { lead_id: "lead-q" })]), true, status);
  assert.equal(await isBookingGap([]), true, "no appointment at all");
});

test("Phase 2-7 (A10): a lead-less appointment for the same contact books the lead when it starts after, or exactly at, the lead's creation", async () => {
  assert.equal(await isBookingGap([appt("scheduled", AFTER)]), false, "after creation");
  assert.equal(await isBookingGap([appt("confirmed", QUALIFIED_CREATED)]), false, "exactly at creation");
  assert.equal(await isBookingGap([appt("scheduled", "2026-10-10T06:00:00.000-06:00")]), false, "the same instant written with an offset - compared as instants, not strings");
  assert.equal(await isBookingGap([appt("completed", AFTER)]), false, "completed still counts as booked (L5)");
});

test("Phase 2-7 (A10): a lead-less appointment does not book the lead when it started before the lead existed, is for a different contact, or is cancelled / a no-show", async () => {
  assert.equal(await isBookingGap([appt("scheduled", BEFORE)]), true, "before creation - old customer history");
  assert.equal(await isBookingGap([appt("scheduled", "2026-10-10T11:59:59.999Z")]), true, "one millisecond before creation");
  assert.equal(await isBookingGap([appt("scheduled", AFTER, { contact_id: `${ORG}-c2` })]), true, "different contact");
  assert.equal(await isBookingGap([appt("scheduled", AFTER, { contact_id: null })]), true, "no contact");
  assert.equal(await isBookingGap([appt("cancelled", AFTER)]), true, "cancelled");
  assert.equal(await isBookingGap([appt("no_show", AFTER)]), true, "no-show");
});

test("Phase 2-7: an appointment linked to a different lead never books this lead, even for the same contact and after creation", async () => {
  assert.equal(await isBookingGap([appt("scheduled", AFTER, { lead_id: "lead-other" })]), true);
});

test("Phase 2-7: multiple appointments - one valid post-creation booking is enough; only invalid ones leave the gap", async () => {
  assert.equal(await isBookingGap([appt("completed", BEFORE), appt("scheduled", AFTER)]), false, "old visit plus a valid new booking");
  assert.equal(
    await isBookingGap([appt("completed", BEFORE), appt("no_show", AFTER), appt("cancelled", AFTER), appt("scheduled", AFTER, { lead_id: "lead-other" }), appt("confirmed", AFTER, { contact_id: `${ORG}-c2` })]),
    true,
    "pre-creation, no-show, cancelled, other lead and other contact only",
  );
});

test("Phase 2-7, revised by Phase 2-8 (M2): a completed lead-less visit after an open lead's creation is now that lead's completed-visit item; a linked one without an estimate still is", async () => {
  // Phase 2-7 pinned "a lead-less completed appointment is never one" while L6 was deferred. Phase 2-8's M2
  // now associates it with the contact's open lead created at or before the visit (lead-q here; lead-other is won).
  const leadless = await detectAllOpportunityCandidates(makeFake(bookingFixture([appt("completed", AFTER)])).client, ORG, NOW);
  assert.deepEqual(leadless.filter((c) => c.type === "completed_appointment_no_estimate").map((c) => [c.sourceEntityId, c.metadata.lead_id]), [["appt-0", "lead-q"]]);
  assert.ok(!leadless.some((c) => c.type === "qualified_lead_unbooked"), "and it still books the lead (Phase 2-7)");
  const linked = await detectAllOpportunityCandidates(makeFake(bookingFixture([appt("completed", AFTER, { lead_id: "lead-q" })])).client, ORG, NOW);
  assert.deepEqual(linked.filter((c) => c.type === "completed_appointment_no_estimate").map((c) => c.sourceEntityId), ["appt-0"]);
});

test("Phase 2-7 structural (revised by Phase 2-8): the booking-gap appointment read is one paged read with lead_id, contact_id, start_at and status, no lead_id filter, and the unchanged booked statuses - now from the shared lifecycle module", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8");
  const start = source.indexOf("async function detectQualifiedLeadsUnbooked(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  // Phase 2-8: status is selected because the shared rule (findUnbookedQualifiedLeads) checks it itself.
  assert.match(body, /checkedAll\("qualified_lead_unbooked\.appointments", \(\) =>\s*supabase\.from\("appointments"\)\.select\("lead_id, contact_id, start_at, status"\)\.eq\("organization_id", organizationId\)\.in\("status", ACTIVE_BOOKING_STATUSES\)\.order\("id"\)/);
  assert.equal((body.match(/from\("appointments"\)/g) ?? []).length, 1);
  assert.match(body, /findUnbookedQualifiedLeads\(leads,/);
  assert.match(source, /const ACTIVE_BOOKING_STATUSES = BOOKED_APPOINTMENT_STATUSES;/);
  const lifecycle = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/lifecycle.ts"), "utf8");
  assert.match(lifecycle, /export const BOOKED_APPOINTMENT_STATUSES = \["scheduled", "confirmed", "completed"\] as const;/);
});

// ---------------------------------------------------------------------------
// Phase 2-8: completed visit with no estimate - one item per open lead,
// through the shared lifecycle rule, keyed to the latest visit, with a
// dismissal of any of the lead's visits carried forward (M1-M5, M8).
// ---------------------------------------------------------------------------

const VISIT_LEAD_CREATED = "2026-10-01T12:00:00.000Z";

/** Contact c1 with one open lead (lead-v, created VISIT_LEAD_CREATED) plus whatever visits, estimates, jobs and opportunities a test adds. */
function visitFixture(extra: { appointments?: Row[]; estimates?: Row[]; jobs?: Row[]; leads?: Row[]; opportunities?: Row[] } = {}): Record<string, Row[]> {
  const tables = scaleFixture(0);
  const c1 = contact(ORG, 1);
  tables.contacts = [c1, contact(ORG, 2)];
  tables.leads = extra.leads ?? [{ id: "lead-v", organization_id: ORG, contact_id: c1.id, status: "estimate", service: "Roof", estimated_value: null, temperature: "warm", created_at: VISIT_LEAD_CREATED, contacts: c1 }];
  tables.appointments = (extra.appointments ?? []).map((row) => ({ organization_id: ORG, title: `Visit ${row.id}`, status: "completed", lead_id: null, contact_id: c1.id, updated_at: DAYS_AGO(1), contacts: c1, ...row }));
  tables.estimates = (extra.estimates ?? []).map((row) => ({ organization_id: ORG, status: "draft", title: "Q", amount: 1, ...row }));
  tables.jobs = (extra.jobs ?? []).map((row) => ({ organization_id: ORG, title: "Job", status: "scheduled", amount: 1, contact_id: null, completed_at: null, created_at: DAYS_AGO(1), estimate_id: null, contacts: null, ...row }));
  tables.opportunities = extra.opportunities ?? [];
  return tables;
}

const visitItems = async (tables: Record<string, Row[]>) =>
  (await detectAllOpportunityCandidates(makeFake(tables).client, ORG, NOW)).filter((c) => c.type === "completed_appointment_no_estimate").map((c) => [c.sourceEntityId, c.metadata.lead_id]);
const openVisitRows = (tables: Record<string, Row[]>) => tables.opportunities.filter((row) => row.type === "completed_appointment_no_estimate" && row.status === "open");

test("Phase 2-8: a lead-linked visit and a lead-less visit after an open lead's creation are flagged; won/lost leads, a job, a lead-linked estimate or a later lead-less estimate clear it", async () => {
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", lead_id: "lead-v", start_at: "2026-10-05T09:00:00.000Z" }] })), [["a1", "lead-v"]]);
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", start_at: "2026-10-05T09:00:00.000Z" }] })), [["a1", "lead-v"]], "lead-less visit, open lead created before it");
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", start_at: "2026-09-05T09:00:00.000Z" }] })), [], "lead-less visit before the lead");
  for (const status of ["won", "lost"]) {
    const tables = visitFixture({ appointments: [{ id: "a1", lead_id: "lead-v", start_at: "2026-10-05T09:00:00.000Z" }] });
    tables.leads[0].status = status;
    assert.deepEqual(await visitItems(tables), [], status);
  }
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", lead_id: "lead-v", start_at: "2026-10-05T09:00:00.000Z" }], jobs: [{ id: "j1", lead_id: "lead-v" }] })), [], "a job for the lead");
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", lead_id: "lead-v", start_at: "2026-10-05T09:00:00.000Z" }], estimates: [{ id: "e1", lead_id: "lead-v", contact_id: null, created_at: "2026-01-01T00:00:00.000Z", status: "declined" }] })), [], "a declined lead-linked estimate (M8)");
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", start_at: "2026-10-05T09:00:00.000Z" }], estimates: [{ id: "e1", lead_id: null, contact_id: `${ORG}-c1`, created_at: "2026-10-06T00:00:00.000Z" }] })), [], "a lead-less estimate after the visit");
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", start_at: "2026-10-05T09:00:00.000Z" }], estimates: [{ id: "e1", lead_id: null, contact_id: `${ORG}-c1`, created_at: "2026-10-04T00:00:00.000Z" }] })), [["a1", "lead-v"]], "a lead-less estimate before the visit");
  assert.deepEqual(await visitItems(visitFixture({ appointments: [{ id: "a1", start_at: "2026-10-05T09:00:00.000Z" }], estimates: [{ id: "e1", lead_id: null, contact_id: `${ORG}-c2`, created_at: "2026-10-06T00:00:00.000Z" }] })), [["a1", "lead-v"]], "another contact's estimate");
});

test("Phase 2-8 (M5): several visits for one lead sync to one row on the latest visit; a second sync creates no duplicate; the alias list is never stored", async () => {
  const tables = visitFixture({ appointments: [{ id: "a-old", lead_id: "lead-v", start_at: "2026-10-03T09:00:00.000Z" }, { id: "a-new", start_at: "2026-10-09T09:00:00.000Z" }, { id: "a-mid", lead_id: "lead-v", start_at: "2026-10-06T09:00:00.000Z" }] });
  const fake = makeFake(tables);
  const first = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(first.created, 1);
  const [row] = openVisitRows(tables);
  assert.equal(row.source_entity_id, "a-new");
  assert.deepEqual(row.metadata, { appointment_start_at: "2026-10-09T09:00:00.000Z", lead_id: "lead-v" });
  assert.ok(!("dismissalAliases" in row) && !("dismissal_aliases" in row), "never persisted");
  const second = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(second.created, 0);
  assert.equal(openVisitRows(tables).length, 1);
});

test("Phase 2-8 (M5): a dismissed row on any of the lead's visits suppresses its item on the latest visit; the dismissed row is untouched", async () => {
  const dismissed = { id: "opp-old", organization_id: ORG, type: "completed_appointment_no_estimate", source_entity_type: "appointment", source_entity_id: "a-old", contact_id: `${ORG}-c1`, status: "dismissed", resolved_at: DAYS_AGO(2), resolution_reason: "dismissed", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(3) };
  const tables = visitFixture({ appointments: [{ id: "a-old", lead_id: "lead-v", start_at: "2026-10-03T09:00:00.000Z" }, { id: "a-new", lead_id: "lead-v", start_at: "2026-10-09T09:00:00.000Z" }], opportunities: [dismissed] });
  const result = await syncOpportunities(makeFake(tables).client, ORG, NOW);
  assert.equal(result.suppressed, 1);
  assert.deepEqual(openVisitRows(tables), []);
  assert.equal(tables.opportunities.find((row) => row.id === "opp-old")!.status, "dismissed");
});

test("Phase 2-8 (M5, approved one-time churn): an open row on an older visit resolves as condition_no_longer_true and the latest visit's row is created", async () => {
  const open = { id: "opp-old", organization_id: ORG, type: "completed_appointment_no_estimate", source_entity_type: "appointment", source_entity_id: "a-old", contact_id: `${ORG}-c1`, status: "open", resolved_at: null, resolution_reason: null, title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(3) };
  const tables = visitFixture({ appointments: [{ id: "a-old", lead_id: "lead-v", start_at: "2026-10-03T09:00:00.000Z" }, { id: "a-new", lead_id: "lead-v", start_at: "2026-10-09T09:00:00.000Z" }], opportunities: [open] });
  const result = await syncOpportunities(makeFake(tables).client, ORG, NOW);
  assert.deepEqual([result.resolved, result.created], [1, 1]);
  const old = tables.opportunities.find((row) => row.id === "opp-old")!;
  assert.deepEqual([old.status, old.resolution_reason], ["resolved", "condition_no_longer_true"]);
  assert.deepEqual(openVisitRows(tables).map((row) => row.source_entity_id), ["a-new"]);
});

test("Phase 2-8 structural: the completed-visit detector makes four paged reads with no lead filter on visits or estimates, and goes through findCompletedVisitsWithoutEstimate", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8");
  const start = source.indexOf("async function detectCompletedAppointmentsWithoutEstimate(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.equal([...body.matchAll(/checkedAll(<[^>]+>)?\(\s*"completed_appointment_no_estimate\./g)].length, 4);
  for (const label of ["appointments", "estimates", "open_leads", "jobs"]) assert.match(body, new RegExp(`"completed_appointment_no_estimate\\.${label}"`));
  assert.doesNotMatch(body.slice(0, body.indexOf("const [estimateRows")), /\.not\("lead_id"/, "visits read has no lead filter");
  assert.match(body, /supabase\.from\("estimates"\)\.select\("lead_id, contact_id, created_at"\)\.eq\("organization_id", organizationId\)\.order\("id"\)/);
  assert.match(body, /findCompletedVisitsWithoutEstimate\(\{ visits: appointments, leads: leadRows, estimates: estimateRows, jobs: jobRows \}\)/);
  assert.match(body, /sourceEntityType: "appointment" as const,\s*sourceEntityId: anchor\.id,/);
});

test("Phase 2-8 parity (structural, M9): Today's detector builds both types with the shared lifecycle functions, and Insights counts exactly those stored open rows", () => {
  const detect = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8");
  const metrics = fs.readFileSync(path.join(process.cwd(), "lib/bi/metrics.ts"), "utf8");
  for (const fn of ["findCompletedVisitsWithoutEstimate", "findUnbookedQualifiedLeads"]) assert.match(detect, new RegExp(`\\b${fn}\\(`), `detector uses ${fn}`);
  assert.match(metrics, /supabase\.from\("opportunities"\)\.select\("id"\)\.eq\("organization_id", organizationId\)\.eq\("type", type\)\.eq\("status", "open"\)\.order\("id"\)/, "Insights reads Today's open rows");
  assert.match(metrics, /return countOpenOpportunities\(supabase, organizationId, "completed_appointment_no_estimate"\);/);
  assert.match(metrics, /return countOpenOpportunities\(supabase, organizationId, "qualified_lead_unbooked"\);/);
  assert.doesNotMatch(metrics, /qualifiedOnly|findCompletedVisitsWithoutEstimate|findUnbookedQualifiedLeads/, "no second, Insights-only reconstruction");
});

// ---------------------------------------------------------------------------
// Phase 2-9 (A15/B6, rulings Q1-Q5): directed cross-type dismissal
// carry-forward for the same source. The fake ignores order(), so fixtures
// list opportunity rows newest first - the order the real read returns.
// ---------------------------------------------------------------------------

const dismissedRow = (id: string, type: string, sourceType: string, sourceId: string, extra: Row = {}): Row => ({ id, organization_id: ORG, type, source_entity_type: sourceType, source_entity_id: sourceId, contact_id: `${ORG}-c1`, status: "dismissed", resolved_at: DAYS_AGO(2), resolution_reason: "dismissed", title: "t", description: null, estimated_value: null, value_basis: null, metadata: {}, created_at: DAYS_AGO(3), ...extra });
const openRow = (id: string, type: string, sourceType: string, sourceId: string, extra: Row = {}): Row => dismissedRow(id, type, sourceType, sourceId, { status: "open", resolved_at: null, resolution_reason: null, ...extra });

function familyFixture(extra: { estimates?: Row[]; leads?: Row[]; jobs?: Row[]; invoices?: Row[]; opportunities?: Row[] }): Record<string, Row[]> {
  const tables = scaleFixture(0);
  const c1 = contact(ORG, 1);
  tables.contacts = [c1];
  tables.estimates = (extra.estimates ?? []).map((row) => ({ organization_id: ORG, contact_id: c1.id, lead_id: null, title: `Quote ${row.id}`, amount: 800, sent_at: DAYS_AGO(40), expires_at: DAYS_AGO(5), contacts: c1, ...row }));
  tables.leads = (extra.leads ?? []).map((row) => ({ organization_id: ORG, contact_id: c1.id, service: "Roof", estimated_value: null, created_at: DAYS_AGO(5), contacts: c1, ...row }));
  tables.jobs = (extra.jobs ?? []).map((row) => ({ organization_id: ORG, contact_id: c1.id, title: `Job ${row.id}`, amount: 1000, status: "completed", completed_at: DAYS_AGO(5), created_at: DAYS_AGO(10), estimate_id: null, contacts: c1, ...row }));
  tables.invoices = (extra.invoices ?? []).map((row) => ({ organization_id: ORG, contact_id: c1.id, number: 7, title: "Invoice", status: "sent", balance_due: 1000, due_date: "2026-09-01", contacts: c1, ...row }));
  tables.opportunities = extra.opportunities ?? [];
  return tables;
}

async function syncFamily(tables: Record<string, Row[]>) {
  const result = await syncOpportunities(makeFake(tables).client, ORG, NOW);
  const open = (type: string) => tables.opportunities.filter((row) => row.type === type && row.status === "open").map((row) => row.source_entity_id).sort();
  return { result, open };
}

test("Phase 2-9 (Q1): a dismissed pending estimate suppresses the later expired (stale) estimate for the same estimate id - other estimates, including another on the same lead, still appear", async () => {
  const tables = familyFixture({
    estimates: [
      { id: "e-dismissed", status: "expired", lead_id: "lead-1" },
      { id: "e-same-lead", status: "expired", lead_id: "lead-1" },
      { id: "e-clean", status: "expired" },
    ],
    opportunities: [dismissedRow("d1", "pending_estimate", "estimate", "e-dismissed")],
  });
  const { result, open } = await syncFamily(tables);
  assert.deepEqual(open("stale_estimate"), ["e-clean", "e-same-lead"]);
  assert.equal(result.suppressed, 1);
  assert.equal(tables.opportunities.find((row) => row.id === "d1")!.status, "dismissed", "the dismissal itself is untouched");
});

test("Phase 2-9 (Q1b): a legacy lead-keyed pending-estimate dismissal does not reach the expired estimate", async () => {
  const tables = familyFixture({
    estimates: [{ id: "e1", status: "expired", lead_id: "lead-1" }],
    opportunities: [dismissedRow("d1", "pending_estimate", "lead", "lead-1")],
  });
  assert.deepEqual((await syncFamily(tables)).open("stale_estimate"), ["e1"]);
});

test("Phase 2-9 (Q2b): a dismissed uncontacted or qualified-unbooked lead suppresses only the later active_lead_signal for the same lead", async () => {
  const hot = (id: string) => ({ id, status: "contacted", temperature: "hot" });
  const tables = familyFixture({
    leads: [hot("lead-u"), hot("lead-q"), hot("lead-clean")],
    opportunities: [dismissedRow("du", "uncontacted_lead", "lead", "lead-u"), dismissedRow("dq", "qualified_lead_unbooked", "lead", "lead-q")],
  });
  const { result, open } = await syncFamily(tables);
  assert.deepEqual(open("active_lead_signal"), ["lead-clean"]);
  assert.equal(result.suppressed, 2);
});

test("Phase 2-9 (Q2b): never the other way - a dismissed uncontacted lead does not suppress a later qualified-unbooked item, a dismissed qualified lead does not suppress uncontacted, and a dismissed active signal suppresses neither", async () => {
  const tables = familyFixture({
    leads: [
      { id: "lead-u-then-q", status: "qualified", temperature: "warm" },
      { id: "lead-q-then-new", status: "new", temperature: "warm", created_at: DAYS_AGO(3) },
      { id: "lead-a-then-q", status: "qualified", temperature: "warm" },
    ],
    opportunities: [
      dismissedRow("d1", "uncontacted_lead", "lead", "lead-u-then-q"),
      dismissedRow("d2", "qualified_lead_unbooked", "lead", "lead-q-then-new"),
      dismissedRow("d3", "active_lead_signal", "lead", "lead-a-then-q"),
    ],
  });
  const { open } = await syncFamily(tables);
  assert.deepEqual(open("qualified_lead_unbooked"), ["lead-a-then-q", "lead-u-then-q"]);
  assert.deepEqual(open("uncontacted_lead"), ["lead-q-then-new"]);
});

test("Phase 2-9 (Q4): an older dismissal never overrides a newer open sibling - the most recent open-or-dismissed row in the group decides", async () => {
  const tables = familyFixture({
    leads: [{ id: "lead-1", status: "contacted", temperature: "hot" }],
    // Newest first: an open qualified row (the lead was qualified after the dismissal), then the older dismissed uncontacted row.
    opportunities: [openRow("o1", "qualified_lead_unbooked", "lead", "lead-1", { created_at: DAYS_AGO(1) }), dismissedRow("d1", "uncontacted_lead", "lead", "lead-1")],
  });
  assert.deepEqual((await syncFamily(tables)).open("active_lead_signal"), ["lead-1"]);
});

test("Phase 2-9 (Q5): an existing open sibling row is never closed by a family dismissal", async () => {
  const tables = familyFixture({
    leads: [{ id: "lead-1", status: "contacted", temperature: "hot" }],
    opportunities: [dismissedRow("d1", "qualified_lead_unbooked", "lead", "lead-1", { created_at: DAYS_AGO(1) }), openRow("o1", "active_lead_signal", "lead", "lead-1", { created_at: DAYS_AGO(5) })],
  });
  const { result, open } = await syncFamily(tables);
  assert.deepEqual(open("active_lead_signal"), ["lead-1"]);
  assert.equal(tables.opportunities.find((row) => row.id === "o1")!.status, "open");
  assert.equal(result.suppressed, 0);
});

test("Phase 2-9 (Q3): the job/invoice family is not carried - a dismissed not-invoiced job still gets its overdue invoice", async () => {
  const tables = familyFixture({
    jobs: [{ id: "job-1" }],
    invoices: [{ id: "inv-1", job_id: "job-1" }],
    opportunities: [dismissedRow("d1", "completed_job_not_invoiced", "job", "job-1")],
  });
  assert.deepEqual((await syncFamily(tables)).open("invoice_overdue"), ["job-1"]);
});

test("Phase 2-9 structural: exactly the two approved directed rules, checked next to the unchanged B1 and M5 clauses", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/detect.ts"), "utf8");
  const start = source.indexOf("const DISMISSAL_CARRY_FORWARD");
  const block = source.slice(start, source.indexOf("];", start) + 2);
  assert.equal(
    block.replace(/\s+/g, " "),
    'const DISMISSAL_CARRY_FORWARD: { to: OpportunityType; from: OpportunityType[] }[] = [ { to: "stale_estimate", from: ["pending_estimate"] }, { to: "active_lead_signal", from: ["uncontacted_lead", "qualified_lead_unbooked"] }, ];',
  );
  assert.match(source, /\(carriedLeadKey !== null && dismissedKeys\.has\(candidateKey\("pending_estimate", carriedLeadKey\)\)\) \|\|/);
  assert.match(source, /\(candidate\.dismissalAliases \?\? \[\]\)\.some\(\(alias\) => dismissedKeys\.has\(candidateKey\(candidate\.type, alias\)\)\) \|\|/);
  assert.match(source, /carryForwardStatus\.get\(candidate\.type\)\?\.get\(candidate\.sourceEntityId\) === "dismissed";/);
});

// ---------------------------------------------------------------------------
// Phase 2-10 (B7): a review request carries no value; every other valued type keeps its value.
// ---------------------------------------------------------------------------

test("Phase 2-10 (B7): a review request has a null value whatever the job's amount; the same job's not-invoiced item keeps the amount; the review still syncs and reaches Today's queue", async () => {
  const tables = scaleFixture(0);
  const c1 = contact(ORG, 1);
  tables.contacts = [c1];
  tables.jobs = [{ id: "job-1", organization_id: ORG, contact_id: c1.id, title: "Roof", amount: 8000, status: "completed", completed_at: DAYS_AGO(3), created_at: DAYS_AGO(10), estimate_id: null, contacts: c1 }];
  tables.review_requests = [];
  tables.invoices = [];
  tables.opportunities = [];
  const candidates = await detectAllOpportunityCandidates(makeFake(tables).client, ORG, NOW);
  const review = candidates.find((c) => c.type === "completed_job_no_review_request")!;
  assert.ok(review, "the review request still appears");
  assert.deepEqual([review.estimatedValue, review.valueBasis, review.sourceEntityType, review.sourceEntityId], [null, null, "job", "job-1"]);
  assert.deepEqual(review.metadata, { job_completed_at: DAYS_AGO(3) }, "metadata unchanged");
  const notInvoiced = candidates.find((c) => c.type === "completed_job_not_invoiced")!;
  assert.deepEqual([notInvoiced.estimatedValue, notInvoiced.valueBasis], [8000, "jobs.amount"], "another valued type keeps its value");

  const fake = makeFake(tables);
  await syncOpportunities(fake.client, ORG, NOW);
  const prioritized = await getPrioritizedOpportunities(fake.client, ORG, NOW);
  const queued = prioritized.find((p) => p.opportunity.type === "completed_job_no_review_request")!;
  assert.ok(queued, "the decision layer still receives the review opportunity");
  assert.equal(queued.opportunity.estimatedValue, null);
  assert.equal(queued.valueState, "not_applicable");
  assert.ok(prioritized.every((p) => p.tier && typeof p.opportunity.id === "string"), "sorting produces a valid list");
});

test("Phase 2-10 (B7): an existing open review row with the old job amount is refreshed to null by the next sync (no new row)", async () => {
  const tables = scaleFixture(0);
  const c1 = contact(ORG, 1);
  tables.contacts = [c1];
  tables.jobs = [{ id: "job-1", organization_id: ORG, contact_id: c1.id, title: "Roof", amount: 8000, status: "completed", completed_at: DAYS_AGO(3), created_at: DAYS_AGO(10), estimate_id: null, contacts: c1 }];
  tables.invoices = [{ id: "inv-1", organization_id: ORG, job_id: "job-1", status: "paid" }];
  tables.opportunities = [{ id: "opp-review", organization_id: ORG, type: "completed_job_no_review_request", source_entity_type: "job", source_entity_id: "job-1", contact_id: c1.id, status: "open", title: "F1 L", description: 'Completed job "Roof" has no review request yet.', estimated_value: 8000, value_basis: "jobs.amount", metadata: {}, created_at: DAYS_AGO(2) }];
  const result = await syncOpportunities(makeFake(tables).client, ORG, NOW);
  assert.equal(result.refreshed, 1);
  const row = tables.opportunities.find((r) => r.id === "opp-review")!;
  assert.deepEqual([row.status, row.estimated_value, row.value_basis], ["open", null, null]);
  assert.equal(tables.opportunities.filter((r) => r.type === "completed_job_no_review_request").length, 1);
});

// ---------------------------------------------------------------------------
// Final Batch 1: the new-lead owner alert - a genuinely new lead with no
// recorded contact reaches Today's attention list 15 minutes after it arrives
// (it used to take 24 hours), once per lead, and never once contacted.
// ---------------------------------------------------------------------------

const MINUTES_AGO = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

test("Final Batch 1: a new lead with no contact is on Today after 15 minutes (not 24 hours), once per lead; still in flight before that; gone once contacted or replied", async () => {
  assert.deepEqual((await uncontactedIds(uncontactedFixture({}, {}, { created_at: MINUTES_AGO(5) }))).ids, [], "5 minutes: the instant reply may still be on its way");
  assert.deepEqual((await uncontactedIds(uncontactedFixture({}, {}, { created_at: MINUTES_AGO(16) }))).ids, ["lead-1"], "16 minutes: the owner's");
  assert.deepEqual((await uncontactedIds(uncontactedFixture({}, {}, { created_at: MINUTES_AGO(60 * 30) }))).ids, ["lead-1"], "older leads are unchanged");

  const twoLeads = uncontactedFixture({}, {}, { created_at: MINUTES_AGO(20) });
  twoLeads.leads.push({ ...twoLeads.leads[0], id: "lead-2", created_at: MINUTES_AGO(40) });
  const { ids } = await uncontactedIds(twoLeads);
  assert.deepEqual([...ids].sort(), ["lead-1", "lead-2"], "one candidate per lead - never a duplicate");

  const contacted = uncontactedFixture({}, {}, { created_at: MINUTES_AGO(20) });
  addMessage(contacted, { id: "conv-1" }, { direction: "outbound", status: "sent", created_at: MINUTES_AGO(19) });
  assert.deepEqual((await uncontactedIds(contacted)).ids, [], "the AI (or a person) reached them: no alert");

  const qualified = uncontactedFixture({}, {}, { created_at: MINUTES_AGO(20), status: "qualified" });
  assert.deepEqual((await uncontactedIds(qualified)).ids, [], "only genuinely new leads - no alert on any other lead change");
});
