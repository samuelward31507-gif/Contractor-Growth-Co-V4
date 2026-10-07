/**
 * Estimate creation duplicate protection and acceptance-timestamp
 * idempotency.
 *
 * Runs the REAL createEstimate server action and the REAL public-approval
 * transition (respondToEstimateByToken) against an in-memory table store.
 * Auth/session plumbing and the downstream automation emitters are mocked
 * (the emitters only count calls); nothing reaches TEST, Production, Twilio
 * or n8n.
 *
 * The acceptance timestamp is `responded_at`: the estimates table has no
 * separate accepted_at column - `status = 'accepted'` plus `responded_at`
 * is the authoritative record of when the customer accepted.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/estimates/estimate-hardening.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
const CONTACT = "contact-1";
const LEAD = "lead-1";

let store: Record<string, Row[]> = {};
let ids = 0;
let now = Date.UTC(2026, 9, 5, 12, 0, 0);
const iso = () => new Date(now).toISOString();
const calls = { lifecycle: [] as string[], jobCreated: 0, linkEvents: [] as string[] };

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private sortBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private singleRow = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  gte(column: string, value: string) { this.filters.push((row) => String(row[column]) >= value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sortBy = { column, ascending: options?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.updateValues = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  single() { return this.maybeSingle(); }
  maybeSingle() { this.singleRow = true; return this.run(); }
  then<T>(resolve: (value: { data: unknown; error: null }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  private async run() {
    if (this.insertRows) {
      const inserted = this.insertRows.map((row) => ({ id: `est-${++ids}`, created_at: iso(), updated_at: iso(), responded_at: null, ...row }));
      (store[this.table] ??= []).push(...inserted);
      return { data: this.singleRow ? inserted[0] : inserted, error: null };
    }
    let rows = (store[this.table] ?? []).filter((row) => this.filters.every((f) => f(row)));
    if (this.updateValues) for (const row of rows) Object.assign(row, this.updateValues, { updated_at: iso() });
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      rows = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return { data: this.singleRow ? (rows[0] ?? null) : rows, error: null };
  }
}
const supabase = {
  from: (table: string) => new Query(table),
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
};

mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/headers", { namedExports: { headers: async () => new Headers() } });
mock.module("next/navigation", { namedExports: { redirect: () => { throw new Error("redirect"); } } });
mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => supabase } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG }) } });
mock.module(lib("lib/automation/estimates.ts"), {
  namedExports: {
    emitEstimateSent: async () => undefined,
    emitEstimateLifecycleEvent: async () => undefined,
    emitEstimateLifecycleEventAsService: async (_s: unknown, _org: string, id: string, type: string) => {
      calls.lifecycle.push(`${type}:${id}`);
    },
  },
});
const realEstimateDelivery = await import(lib("lib/automation/estimate-delivery.ts"));
mock.module(lib("lib/automation/estimate-delivery.ts"), { namedExports: { ...realEstimateDelivery, deliverEstimateToCustomer: async () => ({ status: "skipped", reason: "duplicate" }) } });
mock.module(lib("lib/automation/jobs.ts"), {
  namedExports: {
    emitJobCreatedFromEstimate: async () => undefined,
    emitJobCreatedFromEstimateAsService: async () => {
      calls.jobCreated += 1;
    },
  },
});
mock.module(lib("lib/automation/events.ts"), {
  namedExports: {
    createAutomationEventAsService: async (_s: unknown, _org: string, input: Row) => {
      calls.linkEvents.push(String(input.idempotencyKey));
      return { ok: true, duplicate: false, skipped: false, event: { id: "evt" } };
    },
  },
});

const { createEstimate } = await import(lib("app/(app)/estimates/actions.ts"));
const { respondToEstimateByToken } = await import(lib("lib/estimates/approval.ts"));
const { isSameEstimateSubmission, ESTIMATE_DUPLICATE_WINDOW_MS } = await import(lib("lib/estimates/duplicate-guard.ts"));

const FORM = {
  contactId: CONTACT,
  leadId: LEAD,
  title: "Roof replacement – architectural shingles (TEST)",
  amount: "14850",
  notes: "TEST scope",
  expiresAt: "2026-11-04",
};
function form(overrides: Partial<typeof FORM> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...FORM, ...overrides })) data.set(key, value);
  return data;
}
const create = (overrides: Partial<typeof FORM> = {}) => createEstimate({}, form(overrides));
const estimates = () => store.estimates ?? [];

beforeEach(() => {
  store = { contacts: [{ id: CONTACT, organization_id: ORG }, { id: "contact-2", organization_id: ORG }], estimates: [] };
  ids = 0;
  now = Date.UTC(2026, 9, 5, 12, 0, 0);
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now });
  calls.lifecycle = [];
  calls.jobCreated = 0;
  calls.linkEvents = [];
});

const advance = (ms: number) => {
  now += ms;
  mock.timers.setTime(now);
};

// ---------------------------------------------------------------------------
// 1. Duplicate protection
// ---------------------------------------------------------------------------

test("the same creation request repeated -> exactly one estimate, and the repeat returns the same id", async () => {
  const first = await create();
  const second = await create();

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(second.id, first.id);
  assert.equal(estimates().length, 1);
  assert.equal(estimates()[0]!.status, "draft");
});

test("a rapid duplicate submission (10 seconds later, as observed) -> exactly one estimate", async () => {
  await create();
  advance(10_000);
  await create();
  assert.equal(estimates().length, 1);
});

test("a genuinely new estimate with the same details after the window -> still allowed", async () => {
  await create();
  advance(ESTIMATE_DUPLICATE_WINDOW_MS + 1_000);
  await create();
  assert.equal(estimates().length, 2);
});

test("different estimate details are never deduplicated", async () => {
  await create();
  await create({ amount: "15200" });
  await create({ title: "Gutter replacement" });
  await create({ notes: "Option B scope" });
  await create({ expiresAt: "2026-11-20" });
  await create({ leadId: "" });
  await create({ contactId: "contact-2" });
  assert.equal(estimates().length, 7);
});

test("a sent (no longer draft) estimate does not block an identical new draft - that is a deliberate re-quote", async () => {
  await create();
  estimates()[0]!.status = "sent";
  await create();
  assert.equal(estimates().length, 2);
  assert.deepEqual(estimates().map((e) => e.status), ["sent", "draft"]);
});

test("existing draft behaviour is unchanged: validation errors still stop creation and a created estimate is a draft with the submitted fields", async () => {
  assert.equal((await create({ title: "" })).error, "Enter a title for this estimate.");
  assert.equal((await create({ amount: "-5" })).error, "Amount cannot be negative.");
  assert.equal(estimates().length, 0);

  const result = await create();
  assert.equal(result.success, true);
  assert.deepEqual(
    { status: estimates()[0]!.status, contact: estimates()[0]!.contact_id, lead: estimates()[0]!.lead_id, amount: estimates()[0]!.amount, title: estimates()[0]!.title },
    { status: "draft", contact: CONTACT, lead: LEAD, amount: 14850, title: FORM.title },
  );
});

test("isSameEstimateSubmission compares amounts numerically and expiry as an instant (DB returns numeric as text)", () => {
  const row = { id: "e", lead_id: LEAD, title: "T", amount: "14850", notes: null, expires_at: "2026-11-04T23:59:59.999+00:00" };
  assert.equal(isSameEstimateSubmission(row, { contactId: CONTACT, leadId: LEAD, title: "T", amount: 14850, notes: null, expiresAt: "2026-11-04T23:59:59.999Z" }), true);
  assert.equal(isSameEstimateSubmission(row, { contactId: CONTACT, leadId: LEAD, title: "T", amount: 14850.5, notes: null, expiresAt: "2026-11-04T23:59:59.999Z" }), false);
  assert.equal(isSameEstimateSubmission({ ...row, amount: null }, { contactId: CONTACT, leadId: LEAD, title: "T", amount: 0, notes: null, expiresAt: "2026-11-04T23:59:59.999Z" }), false);
});

// ---------------------------------------------------------------------------
// 2. Acceptance timestamp (responded_at) on the public approval path
// ---------------------------------------------------------------------------

function sentEstimate() {
  store.estimates.push({
    id: "est-sent",
    organization_id: ORG,
    contact_id: CONTACT,
    lead_id: LEAD,
    title: "Roof",
    amount: 14850,
    status: "sent",
    sent_at: iso(),
    responded_at: null,
    expires_at: null,
    approval_token: "tok_0123456789abcdef",
    organization: { name: "QA Fixture Roofing", sms_phone_number: null },
  });
  return store.estimates.at(-1)!;
}

test("first approval -> status accepted and the acceptance timestamp (responded_at) is recorded", async () => {
  const estimate = sentEstimate();
  advance(60_000);

  assert.equal(await respondToEstimateByToken(supabase, "tok_0123456789abcdef", "accept"), "accepted");

  assert.equal(estimate.status, "accepted");
  assert.equal(estimate.responded_at, iso());
});

test("repeated approval -> timestamp unchanged, exactly one acceptance lifecycle, exactly one job trigger, one link event", async () => {
  const estimate = sentEstimate();
  await respondToEstimateByToken(supabase, "tok_0123456789abcdef", "accept");
  const acceptedAt = estimate.responded_at;

  advance(5 * 60_000);
  assert.equal(await respondToEstimateByToken(supabase, "tok_0123456789abcdef", "accept"), "already_responded");
  assert.equal(await respondToEstimateByToken(supabase, "tok_0123456789abcdef", "decline"), "already_responded");

  assert.equal(estimate.status, "accepted");
  assert.equal(estimate.responded_at, acceptedAt, "never overwritten by a repeat");
  assert.deepEqual(calls.lifecycle, ["estimate.accepted:est-sent"]);
  assert.equal(calls.jobCreated, 1);
  assert.deepEqual(calls.linkEvents, ["estimate.accepted_via_link:est-sent"]);
});
