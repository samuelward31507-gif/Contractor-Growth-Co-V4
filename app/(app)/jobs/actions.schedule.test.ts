/**
 * scheduleJob (app/(app)/jobs/actions.ts): set, change and clear when the
 * work is scheduled (jobs.scheduled_for), entered in the organization's
 * timezone. Runs the REAL server action with only its boundaries mocked -
 * the session client (an in-memory jobs table that applies the update's
 * filters the way PostgREST does), the membership lookup, the org timezone
 * and Next's revalidatePath. No network, no database.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test "app/(app)/jobs/actions.schedule.test.ts"
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-mine";
const OTHER_ORG = "org-other";
let jobs: Row[] = [];
let updates: Row[] = [];
let failNextUpdate = false;
const revalidated: string[] = [];

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private values: Row | null = null;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  update(values: Row) { this.values = values; return this; }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  async maybeSingle() {
    assert.equal(this.table, "jobs");
    assert.ok(this.values, "scheduleJob only ever updates");
    updates.push(this.values);
    if (failNextUpdate) {
      failNextUpdate = false;
      return { data: null, error: { message: "write failed" } };
    }
    const matched = jobs.filter((row) => this.filters.every((filter) => filter(row)));
    for (const row of matched) Object.assign(row, this.values);
    return { data: matched[0] ? { id: matched[0].id } : null, error: null };
  }
}
const sessionClient = { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) }, from: (table: string) => new Query(table) };

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => sessionClient } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG }) } });
const realSettings = await import(lib("lib/settings/queries.ts"));
mock.module(lib("lib/settings/queries.ts"), { namedExports: { ...realSettings, getOrganizationTimezone: async () => "America/Denver" } });
mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => void revalidated.push(p), revalidateTag: () => undefined } });

const { scheduleJob } = await import(lib("app/(app)/jobs/actions.ts"));

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const job = (id: string) => jobs.find((row) => row.id === id)!;

beforeEach(() => {
  jobs = [
    { id: "job-1", organization_id: ORG, status: "scheduled", estimate_id: "est-1", scheduled_for: null },
    { id: "job-started", organization_id: ORG, status: "in_progress", estimate_id: "est-2", scheduled_for: null },
    { id: "job-done", organization_id: ORG, status: "completed", estimate_id: "est-3", scheduled_for: null },
    { id: "job-cancelled", organization_id: ORG, status: "cancelled", estimate_id: "est-4", scheduled_for: null },
    { id: "job-theirs", organization_id: OTHER_ORG, status: "scheduled", estimate_id: "est-9", scheduled_for: null },
  ];
  updates = [];
  revalidated.length = 0;
});

test("set: the date and time are read in the organization's timezone and stored as the instant; status is never touched", async () => {
  const result = await scheduleJob({}, form({ jobId: "job-1", date: "2026-11-02", time: "09:00" }));
  assert.deepEqual(result, { success: true });
  assert.equal(job("job-1").scheduled_for, "2026-11-02T16:00:00.000Z", "09:00 in America/Denver (MST)");
  assert.equal(job("job-1").status, "scheduled");
  assert.deepEqual(updates, [{ scheduled_for: "2026-11-02T16:00:00.000Z" }], "only scheduled_for is written");
  assert.deepEqual(revalidated, ["/jobs/job-1", "/today", "/money", "/people"]);
});

test("change, then clear: a reschedule overwrites the instant; Clear sets it back to null (Today's item returns)", async () => {
  await scheduleJob({}, form({ jobId: "job-1", date: "2026-11-02", time: "09:00" }));
  assert.deepEqual(await scheduleJob({}, form({ jobId: "job-1", date: "2026-07-10", time: "13:30" })), { success: true });
  assert.equal(job("job-1").scheduled_for, "2026-07-10T19:30:00.000Z", "13:30 in America/Denver (MDT)");
  assert.deepEqual(await scheduleJob({}, form({ jobId: "job-1", intent: "clear" })), { success: true });
  assert.equal(job("job-1").scheduled_for, null);
  assert.equal(job("job-1").status, "scheduled");
});

test("a job that has started can still have its date recorded; a completed or cancelled job cannot be scheduled", async () => {
  assert.deepEqual(await scheduleJob({}, form({ jobId: "job-started", date: "2026-11-02", time: "09:00" })), { success: true });
  for (const id of ["job-done", "job-cancelled"]) {
    assert.deepEqual(await scheduleJob({}, form({ jobId: id, date: "2026-11-02", time: "09:00" })), { error: "This job could not be found or can no longer be scheduled." }, id);
    assert.equal(job(id).scheduled_for, null, id);
  }
});

test("cross-organization: another organization's job is never written, even with its id", async () => {
  const set = await scheduleJob({}, form({ jobId: "job-theirs", date: "2026-11-02", time: "09:00" }));
  assert.deepEqual(set, { error: "This job could not be found or can no longer be scheduled." });
  job("job-theirs").scheduled_for = "2026-10-01T15:00:00.000Z";
  const clear = await scheduleJob({}, form({ jobId: "job-theirs", intent: "clear" }));
  assert.deepEqual(clear, { error: "This job could not be found or can no longer be scheduled." });
  assert.equal(job("job-theirs").scheduled_for, "2026-10-01T15:00:00.000Z", "untouched");
  assert.deepEqual(revalidated, []);
});

test("invalid input is rejected before any write; a write failure is reported, never claimed as saved", async () => {
  assert.deepEqual(await scheduleJob({}, form({ jobId: "job-1", date: "2026-11-02", time: "" })), { error: "Enter both a date and a time." });
  assert.deepEqual(await scheduleJob({}, form({ jobId: "job-1", date: "", time: "" })), { error: "Enter both a date and a time." }, "an empty Schedule submit never silently clears");
  assert.deepEqual(await scheduleJob({}, form({ jobId: "job-1", date: "2026-02-30", time: "09:00" })), { error: "Enter a valid date and time." });
  assert.deepEqual(await scheduleJob({}, form({ date: "2026-11-02", time: "09:00" })), { error: "This job could not be found." });
  assert.deepEqual(updates, []);
  failNextUpdate = true;
  assert.deepEqual(await scheduleJob({}, form({ jobId: "job-1", date: "2026-11-02", time: "09:00" })), { error: "We couldn't save the schedule." });
  assert.equal(job("job-1").scheduled_for, null);
});
