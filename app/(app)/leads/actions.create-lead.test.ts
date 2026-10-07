/**
 * Final Batch 3: Add Lead -> the existing createLead action creates a real
 * lead in the caller's organization that enters the canonical lifecycle.
 *
 * Runs the REAL createLead server action against an in-memory session client;
 * the lead.created / stage-history emitters are mocked and counted (their own
 * suites cover them). Nothing reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test "app/(app)/leads/actions.create-lead.test.ts"
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
let store: Record<string, Row[]> = {};
let ids = 0;
let currentOrg = ORG;
const revalidated: string[] = [];
const calls = { leadCreated: [] as Row[], stage: [] as Row[] };

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private insertRow: Row | null = null;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  insert(row: Row) { this.insertRow = row; return this; }
  maybeSingle() { return this.run(); }
  single() { return this.run(); }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    const rows = (store[this.table] ??= []);
    if (this.insertRow) {
      // leads RLS/payment policies are not modelled; organization scoping is what this suite checks.
      const row = { id: `${this.table}-${++ids}`, created_at: "2026-10-10T15:00:00.000Z", ...this.insertRow };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    const match = rows.find((row) => this.filters.every((f) => f(row)));
    return { data: match ? { ...match } : null, error: null };
  }
}
const db = { from: (table: string) => new Query(table), rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => db } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: currentOrg, role: "owner", vertical: "contractor" }) } });
mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => void revalidated.push(p) } });
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { throw new Error(`redirect ${to}`); } } });
mock.module(lib("lib/automation/lead-followup.ts"), { namedExports: { emitLeadCreatedFollowup: async (_s: unknown, input: Row) => void calls.leadCreated.push(input) } });
const realStageHistory = await import(lib("lib/automation/lead-stage-history.ts"));
mock.module(lib("lib/automation/lead-stage-history.ts"), { namedExports: { ...realStageHistory, emitLeadStageChanged: async (_s: unknown, input: Row) => void calls.stage.push(input) } });

const { createLead } = await import(lib("app/(app)/leads/actions.ts"));
const { derivePersonLifecycle, findPersonNextStep } = await import(lib("lib/people/next-step.ts"));

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  ids = 0;
  currentOrg = ORG;
  revalidated.length = 0;
  calls.leadCreated = [];
  calls.stage = [];
  store = {
    contacts: [
      { id: "C1", organization_id: ORG, first_name: "Riley" },
      { id: "C-other", organization_id: "org-2", first_name: "Someone else" },
    ],
    leads: [],
  };
});

test("valid creation: a new lead in the caller's organization, origin stage history, lead.created started, People refreshed", async () => {
  const result = await createLead({}, form({ contactId: "C1", service: "Roof repair", source: "Google", temperature: "warm", estimatedValue: "2500" }));
  assert.deepEqual(result, { success: true });
  assert.equal(store.leads!.length, 1);
  const lead = store.leads![0];
  assert.deepEqual(
    { org: lead.organization_id, contact: lead.contact_id, service: lead.service, status: lead.status, temperature: lead.temperature, value: lead.estimated_value, source: lead.source },
    { org: ORG, contact: "C1", service: "Roof repair", status: "new", temperature: "warm", value: 2500, source: "Google" },
  );
  assert.deepEqual(calls.stage.map((entry) => ({ previous: entry.previousStatus, next: entry.newStatus, source: entry.source })), [{ previous: null, next: "new", source: "manual" }]);
  assert.equal(calls.leadCreated.length, 1, "it enters the existing lead.created automation path");
  assert.ok(revalidated.includes("/people") && revalidated.includes("/people/C1") && revalidated.includes("/today"));
});

test("the created lead enters the canonical lifecycle as a new lead with a truthful next action", async () => {
  await createLead({}, form({ contactId: "C1", service: "Roof repair" }));
  const leads = store.leads!.map((row) => ({ id: row.id as string, status: row.status as string, created_at: row.created_at as string }));
  const now = Date.parse("2026-10-10T15:05:00.000Z");
  assert.equal(derivePersonLifecycle({ leads, appointments: [], estimates: [], jobs: [], messages: [], now }).stage, "new_lead");
  const step = findPersonNextStep({ contactId: "C1", leads, appointments: [], estimates: [], jobs: [], messages: [], conversations: [], waitingConversationIds: new Set(), now });
  assert.equal(step?.label, "Respond to new lead");
});

test("required fields are validated before anything is written", async () => {
  assert.deepEqual(await createLead({}, form({ service: "Roof" })), { error: "Select a contact for this lead." });
  assert.deepEqual(await createLead({}, form({ contactId: "C1", service: "   " })), { error: "Enter a service or description for this opportunity." });
  assert.deepEqual(await createLead({}, form({ contactId: "C1", service: "Roof", estimatedValue: "abc" })), { error: "Enter a valid estimated value." });
  assert.deepEqual(await createLead({}, form({ contactId: "C1", service: "Roof", estimatedValue: "-5" })), { error: "Estimated value cannot be negative." });
  assert.equal(store.leads!.length, 0);
  assert.equal(calls.leadCreated.length, 0);
});

test("invalid status/temperature input falls back to new/cold rather than writing an arbitrary value", async () => {
  await createLead({}, form({ contactId: "C1", service: "Roof", status: "bogus", temperature: "lava" }));
  assert.deepEqual({ status: store.leads![0].status, temperature: store.leads![0].temperature }, { status: "new", temperature: "cold" });
});

test("organization isolation: another organization's contact is refused, and the lead's organization always comes from the session", async () => {
  assert.deepEqual(await createLead({}, form({ contactId: "C-other", service: "Roof" })), { error: "Select a valid contact." });
  assert.equal(store.leads!.length, 0);
  await createLead({}, form({ contactId: "C1", service: "Roof", organizationId: "org-2", organization_id: "org-2" }));
  assert.equal(store.leads![0].organization_id, ORG);
});

test("the Add Lead entry point is reachable: People's Leads view, Today (always) and the command menu", () => {
  const people = readFileSync("app/(app)/people/page.tsx", "utf8");
  assert.match(people, /\{leadsView \? <AddLeadButton contacts=\{allContacts\} \/> : null\}/);
  const today = readFileSync("app/(app)/today/page.tsx", "utf8");
  assert.doesNotMatch(today, /contacts\.length > 0 \? \(\s*<div className="shrink-0">\s*<AddLeadButton/);
  assert.match(today, /<AddLeadButton contacts=\{contacts\} \/>/);
  assert.match(readFileSync("lib/ui/command-menu.tsx", "utf8"), /id: "add-lead", label: "Add lead", href: "\/people\?view=leads&new=lead"/);
  // With no contacts the button explains the prerequisite instead of disappearing.
  assert.match(readFileSync("app/(app)/leads/_components/add-lead-button.tsx", "utf8"), /Add a contact first/);
});
