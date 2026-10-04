/**
 * Phase 2-8: the shared lifecycle rules (lib/opportunities/lifecycle.ts)
 * used by both Today's detector and Insights - pure functions, no client.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/lifecycle.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { findCompletedVisitsWithoutEstimate, findUnbookedQualifiedLeads, BOOKED_APPOINTMENT_STATUSES }: typeof import("./lifecycle") = require("./lifecycle.ts");

const T = (iso: string) => iso;
const LEAD_CREATED = T("2026-10-10T12:00:00.000Z");
const lead = (id: string, extra: Partial<{ contact_id: string | null; created_at: string; status: string }> = {}) => ({ id, contact_id: "c1", created_at: LEAD_CREATED, status: "qualified", ...extra });
const visit = (id: string, extra: Partial<{ lead_id: string | null; contact_id: string | null; start_at: string; status: string }> = {}) => ({ id, lead_id: null, contact_id: "c1", start_at: T("2026-10-12T09:00:00.000Z"), status: "completed", ...extra });
const estimate = (extra: Partial<{ lead_id: string | null; contact_id: string | null; created_at: string }> = {}) => ({ lead_id: null, contact_id: "c1", created_at: T("2026-10-13T09:00:00.000Z"), ...extra });

const flagged = (input: Partial<Parameters<typeof findCompletedVisitsWithoutEstimate>[0]>) =>
  findCompletedVisitsWithoutEstimate({ visits: [], leads: [], estimates: [], jobs: [], ...input }).map((r) => ({ lead: r.leadId, anchor: r.anchor.id, visits: r.visitIds }));

// ---------------------------------------------------------------------------
// Association (M1, M2, M3, M4)
// ---------------------------------------------------------------------------

test("a visit linked by lead_id belongs to that open lead; a lead-less visit to the contact's open lead created at or before it", () => {
  assert.deepEqual(flagged({ visits: [visit("v1", { lead_id: "L" })], leads: [lead("L")] }), [{ lead: "L", anchor: "v1", visits: ["v1"] }]);
  assert.deepEqual(flagged({ visits: [visit("v1")], leads: [lead("L")] }), [{ lead: "L", anchor: "v1", visits: ["v1"] }]);
  assert.deepEqual(flagged({ visits: [visit("v1", { start_at: LEAD_CREATED })], leads: [lead("L")] }), [{ lead: "L", anchor: "v1", visits: ["v1"] }], "exactly at creation");
  assert.deepEqual(flagged({ visits: [visit("v1", { start_at: "2026-10-10T06:00:00.000-06:00" })], leads: [lead("L")] }), [{ lead: "L", anchor: "v1", visits: ["v1"] }], "the same instant with an offset");
});

test("M2: a lead-less visit is never flagged when the contact's only open lead was created after it, there is no lead, or the visit has no contact", () => {
  assert.deepEqual(flagged({ visits: [visit("v1", { start_at: "2026-10-10T11:59:59.999Z" })], leads: [lead("L")] }), [], "one millisecond before the lead");
  assert.deepEqual(flagged({ visits: [visit("v1")], leads: [] }), [], "no lead at all");
  assert.deepEqual(flagged({ visits: [visit("v1")], leads: [lead("L", { contact_id: "c2" })] }), [], "another contact's lead");
  assert.deepEqual(flagged({ visits: [visit("v1", { contact_id: null })], leads: [lead("L")] }), [], "no contact on the visit");
  assert.deepEqual(flagged({ visits: [visit("v1", { start_at: "not a date" })], leads: [lead("L")] }), [], "unreadable start");
});

test("M3: with several eligible open leads, the lead-less visit goes to the most recently created one at or before it", () => {
  const leads = [lead("old", { created_at: "2026-09-01T00:00:00.000Z" }), lead("recent", { created_at: "2026-10-11T00:00:00.000Z" }), lead("after", { created_at: "2026-10-20T00:00:00.000Z" })];
  assert.deepEqual(flagged({ visits: [visit("v1")], leads }), [{ lead: "recent", anchor: "v1", visits: ["v1"] }]);
  const tied = [lead("a", { created_at: "2026-10-11T00:00:00.000Z" }), lead("b", { created_at: "2026-10-11T00:00:00.000Z" })];
  assert.deepEqual(flagged({ visits: [visit("v1")], leads: tied }).map((r) => r.lead), ["b"], "ties: highest id");
});

test("M4: only open leads - a visit linked to a won or lost lead is never flagged, and a lead-less visit skips closed leads", () => {
  for (const status of ["won", "lost"]) {
    assert.deepEqual(flagged({ visits: [visit("v1", { lead_id: "L" })], leads: [lead("L", { status })] }), [], status);
    assert.deepEqual(flagged({ visits: [visit("v1")], leads: [lead("L", { status })] }), [], `lead-less, ${status}`);
  }
  for (const status of ["new", "contacted", "qualified", "appointment", "estimate"]) {
    assert.equal(flagged({ visits: [visit("v1", { lead_id: "L" })], leads: [lead("L", { status })] }).length, 1, status);
  }
  assert.deepEqual(flagged({ visits: [visit("v1", { lead_id: "missing" })], leads: [] }), [], "a lead_id with no open lead row");
  const closedNewer = [lead("open", { created_at: "2026-09-01T00:00:00.000Z" }), lead("closed", { created_at: "2026-10-11T00:00:00.000Z", status: "lost" })];
  assert.deepEqual(flagged({ visits: [visit("v1")], leads: closedNewer }).map((r) => r.lead), ["open"]);
});

test("only completed visits count", () => {
  for (const status of ["scheduled", "confirmed", "cancelled", "no_show"]) assert.deepEqual(flagged({ visits: [visit("v1", { lead_id: "L", status })], leads: [lead("L")] }), [], status);
});

// ---------------------------------------------------------------------------
// Clearing (M4 jobs, L5, M8)
// ---------------------------------------------------------------------------

test("M8: an estimate linked to the lead in any status clears it", () => {
  for (const created_at of ["2020-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"]) {
    assert.deepEqual(flagged({ visits: [visit("v1", { lead_id: "L" })], leads: [lead("L")], estimates: [estimate({ lead_id: "L", contact_id: null, created_at })] }), [], `lead-linked, created ${created_at}`);
  }
  assert.equal(flagged({ visits: [visit("v1", { lead_id: "L" })], leads: [lead("L")], estimates: [estimate({ lead_id: "other-lead" })] }).length, 1, "another lead's estimate never clears it");
});

test("L5: a lead-less estimate for the contact clears the lead only when created at or after the visit", () => {
  const base = { visits: [visit("v1")], leads: [lead("L")] };
  assert.deepEqual(flagged({ ...base, estimates: [estimate()] }), [], "after the visit");
  assert.deepEqual(flagged({ ...base, estimates: [estimate({ created_at: "2026-10-12T09:00:00.000Z" })] }), [], "exactly at the visit start");
  assert.equal(flagged({ ...base, estimates: [estimate({ created_at: "2026-10-12T08:59:59.999Z" })] }).length, 1, "before the visit");
  assert.equal(flagged({ ...base, estimates: [estimate({ contact_id: "c2" })] }).length, 1, "another contact's estimate");
  assert.equal(flagged({ ...base, estimates: [estimate({ contact_id: null })] }).length, 1, "an estimate with neither lead nor contact");
});

test("M4: a job linked to the lead clears it; a job for another lead does not", () => {
  const base = { visits: [visit("v1", { lead_id: "L" })], leads: [lead("L")] };
  assert.deepEqual(flagged({ ...base, jobs: [{ lead_id: "L" }] }), []);
  assert.equal(flagged({ ...base, jobs: [{ lead_id: "other" }, { lead_id: null }] }).length, 1);
});

// ---------------------------------------------------------------------------
// One item per lead (M5)
// ---------------------------------------------------------------------------

test("M5: several completed visits for one lead give one item, anchored on the latest visit, listing every visit", () => {
  const visits = [visit("v-old", { lead_id: "L", start_at: "2026-10-11T09:00:00.000Z" }), visit("v-new", { start_at: "2026-10-15T09:00:00.000Z" }), visit("v-mid", { lead_id: "L", start_at: "2026-10-13T09:00:00.000Z" })];
  assert.deepEqual(flagged({ visits, leads: [lead("L")] }), [{ lead: "L", anchor: "v-new", visits: ["v-mid", "v-new", "v-old"] }]);
  const tied = [visit("a", { lead_id: "L" }), visit("b", { lead_id: "L" })];
  assert.deepEqual(flagged({ visits: tied, leads: [lead("L")] }).map((r) => r.anchor), ["b"], "ties: highest id");
});

test("M5 with L5: a lead-less estimate after the lead's earliest visit clears the lead, even if a later visit followed", () => {
  const visits = [visit("v1", { lead_id: "L", start_at: "2026-10-11T09:00:00.000Z" }), visit("v2", { lead_id: "L", start_at: "2026-10-20T09:00:00.000Z" })];
  assert.deepEqual(flagged({ visits, leads: [lead("L")], estimates: [estimate({ created_at: "2026-10-15T09:00:00.000Z" })] }), []);
});

test("separate leads stay separate items, ordered by anchor id", () => {
  const leads = [lead("L1"), lead("L2", { contact_id: "c2" })];
  const visits = [visit("v2", { lead_id: "L2", contact_id: "c2" }), visit("v1", { lead_id: "L1" })];
  assert.deepEqual(flagged({ visits, leads }).map((r) => [r.lead, r.anchor]), [["L1", "v1"], ["L2", "v2"]]);
});

// ---------------------------------------------------------------------------
// Booking gap (Phase 2-7 rule, moved here unchanged)
// ---------------------------------------------------------------------------

test("findUnbookedQualifiedLeads: the Phase 2-7 rule - linked or lead-less-for-contact-after-creation books; cancelled, no-show, other lead, other contact and earlier history do not", () => {
  const appt = (extra: object) => ({ lead_id: null, contact_id: "c1", start_at: "2026-10-15T09:00:00.000Z", status: "scheduled", ...extra });
  const unbooked = (appointments: object[], leads = [lead("L")]) => findUnbookedQualifiedLeads(leads, appointments as never).map((l) => l.id);
  for (const status of BOOKED_APPOINTMENT_STATUSES) assert.deepEqual(unbooked([appt({ lead_id: "L", status })]), [], status);
  assert.deepEqual(unbooked([appt({})]), [], "lead-less, same contact, after creation");
  assert.deepEqual(unbooked([appt({ start_at: LEAD_CREATED })]), [], "exactly at creation");
  for (const [label, extra] of [["cancelled", { status: "cancelled" }], ["no-show", { status: "no_show" }], ["other lead", { lead_id: "other" }], ["other contact", { contact_id: "c2" }], ["before creation", { start_at: "2026-10-10T11:59:59.999Z" }]] as const) {
    assert.deepEqual(unbooked([appt(extra)]), ["L"], label);
  }
  assert.deepEqual(unbooked([], [lead("L", { status: "contacted" })]), [], "only qualified leads are candidates");
});

test("structural: lifecycle.ts does no I/O - no client, no fetch, no supabase import beyond types", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/opportunities/lifecycle.ts"), "utf8");
  assert.doesNotMatch(source, /supabase|fetch\(|\.from\(|await /);
  assert.match(source, /^import \{ OPEN_LEAD_STATUSES, type LeadStatus \} from "@\/lib\/leads\/queries";$/m);
});
