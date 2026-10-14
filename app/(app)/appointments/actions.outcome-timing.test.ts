/**
 * QA: an appointment's outcome (completed / no-show) is recorded only once it
 * has started, and every status change records who made it.
 *
 * Reproduces the TEST finding: appointments abeb62d6 / 17f1fb5f were marked
 * completed on Oct 5, 6 and 8 days before their Oct 11 / Oct 13 start times,
 * with no record of who did it. Runs the REAL updateAppointmentStatus server
 * action against an in-memory store; automation emitters and Google sync are
 * mocked (they only count calls). Nothing reaches a real database.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test "app/(app)/appointments/actions.outcome-timing.test.ts"
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
let store: Record<string, Row[]> = {};
const emitted: string[] = [];

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private singleRow = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  update(values: Row) { this.updateValues = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  maybeSingle() { this.singleRow = true; return this.run(); }
  single() { return this.maybeSingle(); }
  then<T>(resolve: (value: { data: unknown; error: null }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  private async run() {
    const table = (store[this.table] ??= []);
    if (this.insertRows) {
      table.push(...this.insertRows.map((r) => ({ ...r })));
      return { data: null, error: null };
    }
    const rows = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.updateValues) for (const row of rows) Object.assign(row, this.updateValues, { updated_at: new Date().toISOString() });
    const copy = rows.map((r) => ({ ...r }));
    return { data: this.singleRow ? (copy[0] ?? null) : copy, error: null };
  }
}
const supabase = { from: (t: string) => new Query(t), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/navigation", { namedExports: { redirect: () => { throw new Error("redirect"); } } });
mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => supabase } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => supabase } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG }) } });
mock.module(lib("lib/automation/appointments.ts"), {
  namedExports: {
    emitAppointmentCreated: async () => undefined,
    emitAppointmentNoShow: async (_s: unknown, id: string) => { emitted.push(`appointment.no_show:${id}`); },
    emitAppointmentLifecycleEvent: async (_s: unknown, id: string, type: string) => { emitted.push(`${type}:${id}`); },
  },
});
mock.module(lib("lib/calendar/appointment-sync.ts"), {
  namedExports: {
    syncAppointmentCreatedToGoogle: async () => ({}),
    syncAppointmentUpdatedToGoogle: async () => ({}),
    syncAppointmentRemovedFromGoogle: async () => ({}),
  },
});

const { updateAppointmentStatus } = await import(lib("app/(app)/appointments/actions.ts"));
const { checkAppointmentOutcomeTiming, PREMATURE_OUTCOME_ERROR } = await import(lib("lib/appointments/outcome-timing.ts"));

const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
function appointment(id: string, startOffsetMs: number, status = "scheduled"): Row {
  const row = { id, organization_id: ORG, status, start_at: at(startOffsetMs), end_at: at(startOffsetMs + 60 * 60 * 1000), external_event_id: null, external_calendar_id: null };
  store.appointments!.push(row);
  return row;
}
const row = (id: string) => store.appointments!.find((a) => a.id === id)!;
const audits = (id: string) => (store.audit_log ?? []).filter((a) => a.entity_id === id);

beforeEach(() => {
  store = { appointments: [] };
  emitted.length = 0;
});

test("reproduction: marking an appointment completed 6 days before it starts is refused - no status change, no completion event, no audit row", async () => {
  appointment("future-1", 6 * DAY);
  const result = await updateAppointmentStatus("future-1", "completed");
  assert.equal(result.error, PREMATURE_OUTCOME_ERROR);
  assert.equal(row("future-1").status, "scheduled");
  assert.deepEqual(emitted, [], "appointment.completed is not emitted");
  assert.equal(audits("future-1").length, 0);
});

test("no-show is also an outcome: refused before the start time", async () => {
  appointment("future-2", 2 * DAY);
  assert.equal((await updateAppointmentStatus("future-2", "no_show")).error, PREMATURE_OUTCOME_ERROR);
  assert.equal(row("future-2").status, "scheduled");
});

test("once the appointment has started, completing it works, emits appointment.completed once and records who did it", async () => {
  appointment("past-1", -2 * 60 * 60 * 1000);
  const result = await updateAppointmentStatus("past-1", "completed");
  assert.equal(result.error, undefined);
  assert.equal(row("past-1").status, "completed");
  assert.deepEqual(emitted, ["appointment.completed:past-1"]);
  assert.equal(audits("past-1").length, 1);
  assert.deepEqual([audits("past-1")[0].user_id, audits("past-1")[0].action, audits("past-1")[0].metadata], ["user-1", "appointment_status_changed", { from_status: "scheduled", to_status: "completed" }]);

  await updateAppointmentStatus("past-1", "completed");
  assert.deepEqual(emitted, ["appointment.completed:past-1"], "saving the same status again emits nothing");
  assert.equal(audits("past-1").length, 1, "and audits nothing");
});

test("non-outcome changes on a future appointment are unaffected: confirm and cancel still work and are audited", async () => {
  appointment("future-3", 3 * DAY);
  assert.equal((await updateAppointmentStatus("future-3", "confirmed")).error, undefined);
  assert.equal(row("future-3").status, "confirmed");
  assert.equal((await updateAppointmentStatus("future-3", "cancelled")).error, undefined);
  assert.equal(row("future-3").status, "cancelled");
  assert.deepEqual(audits("future-3").map((a) => (a.metadata as Row).to_status), ["confirmed", "cancelled"]);
});

test("the rule is pure and judged against the time being saved (the edit form can move a visit to when it happened and complete it in one save)", () => {
  const now = new Date("2026-10-05T11:01:32Z");
  assert.equal(checkAppointmentOutcomeTiming({ previousStatus: "scheduled", nextStatus: "completed", startAt: "2026-10-13T15:00:00Z", now }), PREMATURE_OUTCOME_ERROR, "the TEST case: Oct 13 visit completed on Oct 5");
  assert.equal(checkAppointmentOutcomeTiming({ previousStatus: "scheduled", nextStatus: "completed", startAt: "2026-10-05T10:00:00Z", now }), null, "rescheduled to the real time - allowed");
  assert.equal(checkAppointmentOutcomeTiming({ previousStatus: "completed", nextStatus: "completed", startAt: "2026-10-13T15:00:00Z", now }), null, "an already-completed record can still be edited");
  assert.equal(checkAppointmentOutcomeTiming({ previousStatus: "scheduled", nextStatus: "cancelled", startAt: "2026-10-13T15:00:00Z", now }), null);
  assert.equal(checkAppointmentOutcomeTiming({ previousStatus: "scheduled", nextStatus: "completed", startAt: "not a date", now }), PREMATURE_OUTCOME_ERROR, "an unreadable start time fails closed");
});

test("every status writer goes through the shared rule: the full edit form, the one-click actions and reschedule all use applyAppointmentUpdate", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "app/(app)/appointments/actions.ts"), "utf8");
  const apply = source.slice(source.indexOf("async function applyAppointmentUpdate("));
  assert.ok(apply.indexOf("checkAppointmentOutcomeTiming(") < apply.indexOf(".update(fieldsWithInvalidation)"), "checked before the write");
  assert.equal((source.match(/from\("appointments"\)\s*\.update\(/g) ?? []).length, 2, "only the shared update and the Google-id cleanup write appointments");
});
