/**
 * emitJobCreatedFromEstimateAsService - the job path for the two estimate
 * acceptances that have no auth session (quote approval link, SMS "yes").
 * Since the TEST-lifecycle acceptance normalization it records the same
 * job.created event and starts the same job_created_followup kickoff as the
 * contractor's manual Accept (the n8n dispatch itself is deferred via
 * after(), so nothing is fetched synchronously). A fake service-role
 * client (tables + RPCs, no auth session) and a stubbed global fetch - no
 * database, no network. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/jobs.service-context.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { emitJobCreatedFromEstimateAsService }: typeof import("./jobs") = require("./jobs.ts");

type Row = Record<string, unknown>;
type Filter = [kind: string, column: string, value: unknown];

const ORG = "org-a";

function makeServiceClient(seed: { leadStatus?: string; jobExists?: boolean; automationPaused?: boolean; duplicateEvent?: boolean; leadId?: string | null } = {}) {
  const leadId = seed.leadId === undefined ? "lead-1" : seed.leadId;
  const tables: Record<string, Row[]> = {
    estimates: [{ id: "est-1", organization_id: ORG, contact_id: "contact-1", lead_id: leadId, title: "Roof", amount: 1300.25, status: "accepted", contact: null, lead: null }],
    jobs: seed.jobExists ? [{ id: "job-existing", organization_id: ORG, estimate_id: "est-1", contact_id: "contact-1", lead_id: leadId, title: "Roof", amount: 1300.25, status: "scheduled", contact: null, lead: null, estimate: null }] : [],
    leads: leadId ? [{ id: leadId, organization_id: ORG, status: seed.leadStatus ?? "estimate" }] : [],
    automation_settings: [],
    organizations: [{ id: ORG, automation_paused: Boolean(seed.automationPaused) }],
    conversations: [],
  };
  const writes: { table: string; op: string; payload: unknown }[] = [];
  const rpcCalls: { fn: string; args: Row }[] = [];

  function builder(table: string) {
    const filters: Filter[] = [];
    let op = "select";
    let payload: unknown;
    let mode: "many" | "single" | "maybe" = "many";
    const matches = (row: Row) => filters.every(([kind, column, value]) => (kind === "eq" ? row[column] === value : kind === "neq" ? row[column] !== value : true));
    function execute() {
      const rows = (tables[table] ??= []);
      let result: Row[] = [];
      let error: { code: string; message: string } | null = null;
      // Copies, like PostgREST: a later update must never mutate an earlier read.
      if (op === "select") result = rows.filter(matches).map((row) => ({ ...row }));
      else if (op === "insert") {
        writes.push({ table, op, payload });
        const row = payload as Row;
        if (table === "jobs" && rows.some((existing) => existing.estimate_id === row.estimate_id)) {
          error = { code: "23505", message: 'duplicate key value violates unique constraint "jobs_estimate_id_unique"' };
        } else {
          const insertedRow = { id: `${table}-new`, contact: null, lead: null, estimate: null, ...row };
          rows.push(insertedRow);
          result = [insertedRow];
        }
      } else if (op === "update") {
        writes.push({ table, op, payload });
        result = rows.filter(matches);
        for (const row of result) Object.assign(row, payload as Row);
      }
      if (error) return { data: null, error };
      if (mode === "single") return result.length === 1 ? { data: result[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
      if (mode === "maybe") return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (rows: unknown) => ((op = "insert"), (payload = rows), b),
      update: (patch: unknown) => ((op = "update"), (payload = patch), b),
      eq: (column: string, value: unknown) => (filters.push(["eq", column, value]), b),
      neq: (column: string, value: unknown) => (filters.push(["neq", column, value]), b),
      order: () => b,
      limit: () => b,
      single: () => ((mode = "single"), b),
      maybeSingle: () => ((mode = "maybe"), b),
      then: (resolve: (value: unknown) => void) => resolve(execute()),
    };
    return b;
  }

  function respond(fn: string, args: Row) {
    if (fn === "create_automation_event") {
      return { data: { id: `evt-${rpcCalls.length}`, organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, status: "pending", payload: args.p_payload, is_duplicate: args.p_event_type === "job.created" && Boolean(seed.duplicateEvent) }, error: null };
    }
    if (fn === "start_workflow_execution") return { data: { id: `exec-${rpcCalls.length}`, organization_id: ORG, workflow_name: args.p_workflow_name, attempt: 1, status: "running" }, error: null };
    if (fn === "complete_workflow_execution") return { data: { id: args.p_execution_id, organization_id: ORG, workflow_name: "lifecycle", attempt: 1, status: "completed" }, error: null };
    return { data: {}, error: null };
  }

  const client = {
    // A service-role client has no user session; anything that required one
    // (the session emitters) would fail here - which is the original bug.
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from: builder,
    rpc: (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      const result = respond(fn, args);
      return { single: () => Promise.resolve(result), then: (resolve: (value: unknown) => void) => resolve(result) };
    },
  } as unknown as SupabaseClient;

  return { client, tables, writes, rpcCalls };
}

async function withNoNetwork<T>(fn: () => Promise<T>): Promise<{ result: T; fetches: number }> {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("no network allowed");
  }) as typeof fetch;
  try {
    return { result: await fn(), fetches };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const events = (rpcCalls: { fn: string; args: Row }[]) => rpcCalls.filter((call) => call.fn === "create_automation_event").map((call) => call.args);

test("creates the job, syncs the lead to won, and records lead.stage_changed and the SAME job.created + job_created_followup kickoff as the manual Accept - all via the service RPC with the trusted organization id", async () => {
  const { client, tables, rpcCalls } = makeServiceClient();
  const { fetches } = await withNoNetwork(() => emitJobCreatedFromEstimateAsService(client, ORG, "est-1"));

  assert.equal(tables.jobs.length, 1);
  assert.equal(tables.jobs[0].estimate_id, "est-1");
  assert.equal(tables.jobs[0].organization_id, ORG);
  assert.equal(tables.leads[0].status, "won");

  const recorded = events(rpcCalls);
  assert.deepEqual(recorded.map((args) => args.p_event_type), ["lead.stage_changed", "job.created"]);

  const stage = recorded[0];
  assert.equal(stage.p_organization_id, ORG);
  assert.equal(stage.p_entity_id, "lead-1");
  assert.equal(stage.p_idempotency_key, "lead.stage_changed:lead-1:won:est-1", "same key as the session path");
  assert.equal((stage.p_payload as Row).previous_status, "estimate");
  assert.equal((stage.p_payload as Row).new_status, "won");
  assert.equal((stage.p_payload as Row).source, "automation");

  const job = recorded[1];
  assert.equal(job.p_organization_id, ORG);
  assert.equal(job.p_entity_type, "job");
  assert.equal(job.p_entity_id, "jobs-new");
  assert.equal(job.p_idempotency_key, "job.created:jobs-new", "identical key to the session path, so one job.created per job whichever path created it");
  assert.deepEqual(job.p_payload, { job_id: "jobs-new", estimate_id: "est-1", contact_id: "contact-1", lead_id: "lead-1", conversation_id: "conversations-new" }, "the same payload shape the manual Accept stores");

  const starts = rpcCalls.filter((call) => call.fn === "start_workflow_execution").map((call) => call.args.p_workflow_name);
  assert.deepEqual(starts, ["lead_stage_changed_lifecycle", "job_created_followup"], "the customer's own acceptance gets the same kickoff automation");
  const completions = rpcCalls.filter((call) => call.fn === "complete_workflow_execution").map((call) => call.args.p_metadata);
  assert.deepEqual(completions, [{ lifecycle_only: true, lead_id: "lead-1" }], "the kickoff execution is completed later by the n8n callback, never here");
  assert.equal(fetches, 0, "the n8n dispatch is deferred via after(), never a synchronous call");
});

test("no direct outbound: only the job, the lead and the customer's SMS conversation are written - no message row, nothing fetched; any customer text can only come from the n8n callback through the outbound gate", async () => {
  const { client, writes, rpcCalls } = makeServiceClient();
  const { fetches } = await withNoNetwork(() => emitJobCreatedFromEstimateAsService(client, ORG, "est-1"));
  assert.equal(fetches, 0, "no n8n webhook, no Twilio, no email provider called synchronously");
  assert.deepEqual([...new Set(writes.map((write) => write.table))].sort(), ["conversations", "jobs", "leads"], "no messages table write");
  assert.equal(rpcCalls.some((call) => call.fn === "fail_workflow_execution"), false);
});

test("idempotent replay: an existing job for the estimate is resolved (no second job), a lead already won is not re-transitioned, and a duplicate job.created key starts no execution", async () => {
  const { client, tables, rpcCalls } = makeServiceClient({ jobExists: true, leadStatus: "won", duplicateEvent: true });
  await withNoNetwork(() => emitJobCreatedFromEstimateAsService(client, ORG, "est-1"));
  assert.equal(tables.jobs.length, 1);
  const recorded = events(rpcCalls);
  assert.deepEqual(recorded.map((args) => args.p_event_type), ["job.created"], "no stage change when the lead was already won");
  assert.equal(recorded[0].p_idempotency_key, "job.created:job-existing");
  assert.equal(rpcCalls.filter((call) => call.fn === "start_workflow_execution").length, 0, "duplicate: no execution");
});

test("the job-lifecycle catalog gate still applies: a paused organization records the job and stage change but no job.created marker", async () => {
  const { client, tables, rpcCalls } = makeServiceClient({ automationPaused: true });
  await withNoNetwork(() => emitJobCreatedFromEstimateAsService(client, ORG, "est-1"));
  assert.equal(tables.jobs.length, 1);
  assert.deepEqual(events(rpcCalls).map((args) => args.p_event_type), ["lead.stage_changed"], "lead.stage_changed is ungated; job.created follows the same toggle as the session path");
});

test("an estimate with no lead records only job.created; an unknown estimate (or one from another organization) writes nothing; nothing ever throws", async () => {
  const noLead = makeServiceClient({ leadId: null });
  await withNoNetwork(() => emitJobCreatedFromEstimateAsService(noLead.client, ORG, "est-1"));
  assert.deepEqual(events(noLead.rpcCalls).map((args) => args.p_event_type), ["job.created"]);

  const otherOrg = makeServiceClient();
  await assert.doesNotReject(() => emitJobCreatedFromEstimateAsService(otherOrg.client, "org-b", "est-1"));
  assert.equal(otherOrg.writes.length, 0);
  assert.equal(otherOrg.rpcCalls.length, 0);
});

test("Phase 2B: a job created from an estimate inherits the estimate's lead; an estimate without a lead leaves the job blank", async () => {
  const linked = makeServiceClient({ leadId: "lead-7" });
  await withNoNetwork(() => emitJobCreatedFromEstimateAsService(linked.client, ORG, "est-1"));
  assert.equal(linked.tables.jobs[0].lead_id, "lead-7");
  assert.equal(linked.tables.jobs[0].estimate_id, "est-1");

  const unlinked = makeServiceClient({ leadId: null });
  await withNoNetwork(() => emitJobCreatedFromEstimateAsService(unlinked.client, ORG, "est-1"));
  assert.equal(unlinked.tables.jobs[0].lead_id, null, "no heuristic: no estimate lead means no job lead");
});

test("Phase 2B: both estimate → job paths copy the estimate's lead, and a job that already exists is never rewritten", async () => {
  const jobs = fs.readFileSync(path.join(process.cwd(), "lib/automation/jobs.ts"), "utf8");
  assert.equal([...jobs.matchAll(/lead_id: estimate\.lead_id,\s*estimate_id: estimateId/g)].length, 2);

  const existing = makeServiceClient({ jobExists: true, leadId: "lead-1" });
  existing.tables.jobs[0].lead_id = "lead-explicit";
  await withNoNetwork(() => emitJobCreatedFromEstimateAsService(existing.client, ORG, "est-1"));
  assert.equal(existing.tables.jobs.length, 1);
  assert.equal(existing.tables.jobs[0].lead_id, "lead-explicit");
  assert.ok(!existing.writes.some((write) => write.table === "jobs" && write.op === "update" && (write.payload as Row)?.lead_id !== undefined));
});

test("every acceptance path converges on emitJobCreatedEvent: the service callers through emitJobCreatedFromEstimateAsService (service mode), the manual Accept through the session variant", () => {
  const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
  const approval = read("lib/estimates/approval.ts");
  const reply = read("lib/automation/estimate-reply.ts");
  const manual = read("app/(app)/estimates/actions.ts");
  const jobs = read("lib/automation/jobs.ts");
  assert.match(approval, /await emitJobCreatedFromEstimateAsService\(service, estimate\.organizationId, estimate\.id\)/);
  assert.match(reply, /await emitJobCreatedFromEstimateAsService\(supabase, organizationId, activeEstimate\.id\)/);
  assert.doesNotMatch(approval, /emitJobCreatedFromEstimate\(/);
  assert.doesNotMatch(reply, /emitJobCreatedFromEstimate\(/);
  assert.match(manual, /await emitJobCreatedFromEstimate\(supabase, organizationId, estimateId\)/);
  const serviceVariant = jobs.slice(jobs.indexOf("export async function emitJobCreatedFromEstimateAsService"), jobs.indexOf("export async function emitJobCreatedEvent"));
  assert.match(serviceVariant, /await emitJobCreatedEvent\(supabase, organizationId, jobId, estimateId, "service"\)/);
  assert.doesNotMatch(serviceVariant, /triggerN8nWorkflow|sendOutboundMessage|job_created_lifecycle/, "no second, divergent dispatch or send path");
});
