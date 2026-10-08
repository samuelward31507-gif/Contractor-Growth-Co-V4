/**
 * Job scheduling state (jobs.scheduled_for): the pending migration, the one
 * shared rule (isApprovedJobAwaitingSchedule), the org-timezone parsing the
 * job page uses, Today's "Customer approved — schedule the work" item, and
 * the person's next step. No network, no database - Today runs the real
 * getDashboardData against a hand-built client answering at the wire
 * boundary (the convention lib/dashboard/queries.no-truncation.test.ts uses).
 * The DB-level checks of the migration itself run in PGlite:
 * supabase/pending/scratch/validate-job-scheduled-for.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/jobs/schedule.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isApprovedJobAwaitingSchedule, jobScheduleInputValues, parseJobSchedule } from "./schedule";
import { findPersonNextStep, lifecyclePolicyFrom, type PersonNextStepInput } from "@/lib/people/next-step";
import { assembleDecisions } from "@/lib/decisions/assemble";
import { ATTENTION_COPY } from "@/lib/today/copy";

const require = createRequire(import.meta.url);
const { getDashboardData }: typeof import("@/lib/dashboard/queries") = require(path.join(process.cwd(), "lib/dashboard/queries.ts"));

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
// SQL comments and string literals (the column comment's own text) removed - only the statements themselves.
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");

type Row = Record<string, unknown>;
const approvedJob = (overrides: Row = {}) => ({ status: "scheduled", estimate_id: "est-1", scheduled_for: null as string | null | undefined, ...overrides });

// ---------------------------------------------------------------------------
// 1. Database state (structure here; behavior in the PGlite validator)
// ---------------------------------------------------------------------------

test("1. the migration adds one nullable timestamptz column - no default, no backfill, no status change - and its rollback drops only it", () => {
  const up = withoutComments(read("supabase/pending/job_scheduled_for.sql"));
  assert.match(up, /alter table public\.jobs add column if not exists scheduled_for timestamp with time zone;/);
  assert.doesNotMatch(up, /\bdefault\b/i, "no default");
  assert.doesNotMatch(up, /\bnot null\b/i, "nullable");
  assert.doesNotMatch(up, /\bupdate\b|\binsert\b/i, "no backfill");
  assert.doesNotMatch(up, /\bstatus\b|\bpolicy\b|\bconstraint\b|\bindex\b/i, "status meaning, RLS, constraints and indexes untouched");
  assert.deepEqual(up.split(";").map((statement) => statement.trim().split(/\s+/).slice(0, 2).join(" ")).filter(Boolean), ["alter table", "comment on"], "exactly two statements");
  const down = withoutComments(read("supabase/pending/job_scheduled_for_rollback.sql"));
  assert.equal(down.trim(), "alter table public.jobs drop column if exists scheduled_for;");
  assert.match(read("supabase/pending/README.md"), /## job_scheduled_for\.sql[\s\S]*apply[\s\S]*BEFORE deploying/i);
});

// ---------------------------------------------------------------------------
// The shared rule
// ---------------------------------------------------------------------------

test("2. accepted estimate + its job exists + not started + no scheduled_for -> awaiting schedule", () => {
  assert.equal(isApprovedJobAwaitingSchedule(approvedJob(), "accepted"), true);
});

test("3. never for an estimate that is awaiting a decision, declined, withdrawn or expired", () => {
  for (const status of ["draft", "sent", "viewed", "declined", "cancelled", "expired", null, undefined]) {
    assert.equal(isApprovedJobAwaitingSchedule(approvedJob(), status), false, String(status));
  }
});

test("4. never for a job with no estimate (created directly), and a job that does not exist has nothing to evaluate", () => {
  assert.equal(isApprovedJobAwaitingSchedule(approvedJob({ estimate_id: null }), "accepted"), false);
});

test("5. never once the work is scheduled - and an unread scheduled_for (undefined) is never treated as unscheduled", () => {
  assert.equal(isApprovedJobAwaitingSchedule(approvedJob({ scheduled_for: "2026-11-02T16:00:00.000Z" }), "accepted"), false);
  assert.equal(isApprovedJobAwaitingSchedule(approvedJob({ scheduled_for: undefined }), "accepted"), false);
});

test("6. never for a job that has started, completed or been cancelled", () => {
  for (const status of ["in_progress", "completed", "cancelled"]) {
    assert.equal(isApprovedJobAwaitingSchedule(approvedJob({ status }), "accepted"), false, status);
  }
});

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

type JobRow = { id: string; title: string; amount: number | null; status: string; estimate_id: string | null; scheduled_for: string | null; estimate: { status: string } | null; contact: { first_name: string | null; last_name: string | null } | null };
const jobRow = (id: string, overrides: Partial<JobRow> = {}): JobRow => ({
  id,
  title: "Roof replacement",
  amount: 12400,
  status: "scheduled",
  estimate_id: `est-${id}`,
  scheduled_for: null,
  estimate: { status: "accepted" },
  contact: { first_name: "Dana", last_name: "Reyes" },
  ...overrides,
});

const EMPTY_RECORD_ATTENTION = {
  overdue_appointments: [],
  awaiting_confirmation: [],
  hot_leads: [],
  high_value_leads: [],
  pending_estimate_leads: [],
  uncontacted_dedup_lead_ids: [],
  recent_leads: [],
  recent_appointments: [],
  new_leads: 0,
  open_leads: 0,
  upcoming_appointments: 0,
  pending_estimates: 0,
  pipeline: { new: 0, contacted: 0, qualified: 0, appointment: 0, estimate: 0, won: 0 },
};

/** Answers every read; the jobs read returns `jobs` as given (unfiltered) so the shared rule is what excludes rows, and records the filters it was sent. */
function todayClient(jobs: { data: JobRow[] | null; error: { message: string } | null }) {
  const jobFilters: string[] = [];
  const builder = (table: string, result: unknown) => {
    const b: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "not", "is", "order"]) {
      b[name] = (...args: unknown[]) => {
        if (table === "jobs" && name !== "select") jobFilters.push(`${name}:${args.map(String).join(",")}`);
        return b;
      };
    }
    b.limit = () => Promise.resolve(result);
    b.range = () => Promise.resolve(result);
    b.maybeSingle = () => Promise.resolve({ data: null, error: null });
    return b;
  };
  const client = {
    from: (table: string) => builder(table, table === "jobs" ? jobs : { data: [], error: null }),
    rpc: (name: string) =>
      Promise.resolve(
        name === "dashboard_record_attention" ? { data: EMPTY_RECORD_ATTENTION, error: null } : name === "dashboard_conversation_attention" ? { data: [], error: null } : { data: null, error: { message: `unexpected rpc ${name}` } },
      ),
  } as unknown as SupabaseClient;
  return { client, jobFilters };
}

const loadToday = (jobs: JobRow[]) => getDashboardData(todayClient({ data: jobs, error: null }).client, "org-1", { conversationAttention: "sql", recordAttention: "sql" });
const scheduleItems = (items: { kind: string }[]) => items.filter((item) => item.kind === "approved_job_unscheduled");

test("7. Today: one item per approved, unscheduled job - on the job, with the customer's name, value and the approval as its reason; org-scoped read", async () => {
  const { client, jobFilters } = todayClient({ data: [jobRow("j1")], error: null });
  const data = await getDashboardData(client, "org-1", { conversationAttention: "sql", recordAttention: "sql" });
  assert.equal(data.partialData, false);
  assert.deepEqual(scheduleItems(data.attentionItems), [
    { id: "approved-job-j1", kind: "approved_job_unscheduled", title: "Dana Reyes", detail: "The customer approved this estimate.", value: "$12,400", href: "/jobs/j1" },
  ]);
  // The read is this organization's not-started, unscheduled, estimate-created jobs.
  for (const filter of ["eq:organization_id,org-1", "eq:status,scheduled", "is:scheduled_for,null", "not:estimate_id,is,null"]) {
    assert.ok(jobFilters.includes(filter), filter);
  }
  assert.equal(ATTENTION_COPY.approved_job_unscheduled.label, "Customer approved — schedule the work");
});

test("8. Today: never for awaiting / declined / withdrawn / expired estimates, scheduled work, started, completed or cancelled jobs, or a job with no estimate", async () => {
  const data = await loadToday([
    jobRow("sent", { estimate: { status: "sent" } }),
    jobRow("declined", { estimate: { status: "declined" } }),
    jobRow("withdrawn", { estimate: { status: "cancelled" } }),
    jobRow("expired", { estimate: { status: "expired" } }),
    jobRow("booked", { scheduled_for: "2026-11-02T16:00:00.000Z" }),
    jobRow("started", { status: "in_progress" }),
    jobRow("done", { status: "completed" }),
    jobRow("cancelled", { status: "cancelled" }),
    jobRow("direct", { estimate_id: null, estimate: null }),
  ]);
  assert.deepEqual(scheduleItems(data.attentionItems), []);
});

test("9. Today: the item clears once the work is scheduled, and returns if the date is cleared - nothing is persisted", async () => {
  assert.equal(scheduleItems((await loadToday([jobRow("j1")])).attentionItems).length, 1);
  assert.equal(scheduleItems((await loadToday([jobRow("j1", { scheduled_for: "2026-11-02T16:00:00.000Z" })])).attentionItems).length, 0);
  assert.equal(scheduleItems((await loadToday([jobRow("j1", { scheduled_for: null })])).attentionItems).length, 1);
  // A failed read is disclosed as partial data, never shown as "nothing to schedule" silently.
  const failed = await getDashboardData(todayClient({ data: null, error: { message: "boom" } }).client, "org-1", { conversationAttention: "sql", recordAttention: "sql" });
  assert.equal(failed.partialData, true);
  assert.deepEqual(scheduleItems(failed.attentionItems), []);
});

test("10. Today's decision row: 'Customer approved — schedule the work', the approval + 'Set the date for the work.', and a 'Schedule the work' button to the job", async () => {
  const data = await loadToday([jobRow("j1")]);
  const decisions = assembleDecisions({ attentionItems: data.attentionItems, prioritizedOpportunities: [] });
  const all = [...decisions.attention, ...decisions.opportunities];
  const rows = all.filter((item) => item.reasonCode === "approved_job_unscheduled");
  assert.equal(rows.length, 1, "exactly one row for the job");
  const [row] = rows;
  assert.equal(row.problemLabel, "Customer approved — schedule the work");
  assert.equal(row.sentence, "The customer approved this estimate. Set the date for the work.");
  assert.deepEqual(row.nextAction, { code: "schedule_work", label: "Schedule the work", href: "/jobs/j1", automatable: false });
  assert.deepEqual(row.subject, { name: "Dana Reyes", href: "/jobs/j1" });
  assert.equal(row.actor, "human");
});

// ---------------------------------------------------------------------------
// The person's next step
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-10T15:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
function person(estimateStatus: string, job: Row): PersonNextStepInput {
  return {
    contactId: "C1",
    leads: [{ id: "L1", status: "won", created_at: daysAgo(5) }] as never,
    appointments: [],
    estimates: [{ id: "E1", lead_id: "L1", status: estimateStatus, title: "Roof replacement", sent_at: daysAgo(2), expires_at: null, created_at: daysAgo(3) }] as never,
    jobs: [{ id: "J1", lead_id: "L1", estimate_id: "E1", status: "scheduled", title: "Roof job", created_at: daysAgo(1), completed_at: null, scheduled_for: null, ...job }] as never,
    invoices: [],
    conversations: [],
    waitingConversationIds: new Set(),
    policy: lifecyclePolicyFrom(),
    timeZone: "UTC",
    jobsEnabled: true,
    now: NOW,
  };
}

test("11. next step: 'Schedule the work' on the job while it is unscheduled; 'Job in progress' once scheduled, started, or when not read", () => {
  assert.deepEqual(findPersonNextStep(person("accepted", {})), { label: "Schedule the work", detail: "Customer approved · Roof job", href: "/jobs/J1", attention: true });
  assert.equal(findPersonNextStep(person("accepted", { scheduled_for: "2026-11-02T16:00:00.000Z" }))?.label, "Job in progress");
  assert.equal(findPersonNextStep(person("accepted", { status: "in_progress" }))?.label, "Job in progress");
  assert.equal(findPersonNextStep(person("accepted", { scheduled_for: undefined }))?.label, "Job in progress");
  assert.equal(findPersonNextStep(person("accepted", { estimate_id: null }))?.label, "Job in progress");
});

// ---------------------------------------------------------------------------
// Entering the date and time (organization timezone)
// ---------------------------------------------------------------------------

test("12. date and time are the organization's wall-clock time, DST-safe; both empty clears; partial or out-of-range input is rejected", () => {
  assert.deepEqual(parseJobSchedule("2026-01-15", "09:30", "America/Denver"), { scheduledFor: "2026-01-15T16:30:00.000Z" });
  assert.deepEqual(parseJobSchedule("2026-07-15", "09:30", "America/Denver"), { scheduledFor: "2026-07-15T15:30:00.000Z" });
  assert.deepEqual(parseJobSchedule("2026-07-15", "09:30", "America/New_York"), { scheduledFor: "2026-07-15T13:30:00.000Z" });
  assert.deepEqual(parseJobSchedule("2026-07-15", "09:30", null), { scheduledFor: "2026-07-15T09:30:00.000Z" }, "no configured zone -> UTC");
  assert.deepEqual(parseJobSchedule("", "  ", "America/Denver"), { scheduledFor: null });
  assert.deepEqual(parseJobSchedule("2026-07-15", "", "America/Denver"), { error: "Enter both a date and a time." });
  assert.deepEqual(parseJobSchedule("", "09:30", "America/Denver"), { error: "Enter both a date and a time." });
  for (const [date, time] of [["2026-02-30", "09:00"], ["2026-13-01", "09:00"], ["2026-07-15", "24:00"], ["2026-07-15", "09:60"], ["15/07/2026", "09:00"], ["1999-12-31", "09:00"]]) {
    assert.deepEqual(parseJobSchedule(date, time, "America/Denver"), { error: "Enter a valid date and time." }, `${date} ${time}`);
  }
});

test("13. a stored time reads back as the same wall-clock date and time in the organization's timezone (so Change pre-fills correctly)", () => {
  for (const zone of ["America/Denver", "America/New_York", "Pacific/Honolulu", "UTC"]) {
    for (const [date, time] of [["2026-01-15", "09:30"], ["2026-07-15", "17:05"], ["2026-11-01", "00:15"]]) {
      const parsed = parseJobSchedule(date, time, zone);
      assert.deepEqual(jobScheduleInputValues(parsed.scheduledFor!, zone), { date, time }, `${zone} ${date} ${time}`);
    }
  }
  assert.deepEqual(jobScheduleInputValues(null, "America/Denver"), { date: "", time: "" });
});
