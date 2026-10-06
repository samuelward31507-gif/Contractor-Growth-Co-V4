/**
 * P0-B B1: characterization - the lifecycle model's status sets are pinned to
 * the definitions the codebase already uses (and the database CHECKs), so the
 * canonical layer can never silently drift from the systems it interprets.
 * Also proves B1 wired NO existing consumer to the new model.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/lifecycle/statuses.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as S from "./statuses";
import { LEAD_STATUSES, OPEN_LEAD_STATUSES } from "@/lib/leads/queries";
import { ACTIVE_APPOINTMENT_STATUSES, ACTIVE_JOB_STATUSES } from "@/lib/automation/lifecycle-eligibility";
import { BOOKED_APPOINTMENT_STATUSES } from "@/lib/opportunities/lifecycle";
import { REVIEW_REQUEST_STATUSES, REFERRAL_REQUEST_STATUSES } from "@/lib/reviews-referrals/queries";

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const sorted = (values: readonly string[]) => [...values].sort();
const checkList = (sql: string, table: string): string[] => {
  // The status CHECK of `create table public.<table>` in the given migration.
  const start = new RegExp(`create table (if not exists )?public\\.${table} \\(`).exec(sql);
  assert.ok(start, `create table ${table}`);
  const body = sql.slice(start!.index);
  const match = /status text not null[^\n]*check \(status in \(([^)]*)\)\)/.exec(body);
  assert.ok(match, `status CHECK for ${table}`);
  return match![1].split(",").map((value) => value.trim().replace(/'/g, ""));
};

test("lead statuses: same values as lib/leads/queries.ts (and the leads CHECK); open = OPEN_LEAD_STATUSES", () => {
  assert.deepEqual(sorted(S.LEAD_STATUS_VALUES), sorted(LEAD_STATUSES.map((status) => status.value)));
  assert.deepEqual(sorted(S.LEAD_STATUS_VALUES), sorted(checkList(read("supabase/migrations/20260917000000_baseline_schema_reconstruction.sql"), "leads")));
  assert.deepEqual(sorted(S.OPEN_LEAD_STATUS_VALUES), sorted([...OPEN_LEAD_STATUSES]));
});

test("appointment statuses: the appointments CHECK; active = A3's set; booked = lib/opportunities/lifecycle.ts", () => {
  assert.deepEqual(sorted(S.APPOINTMENT_STATUS_VALUES), sorted(checkList(read("supabase/migrations/20260917000000_baseline_schema_reconstruction.sql"), "appointments")));
  assert.deepEqual(sorted(S.ACTIVE_APPOINTMENT_STATUS_VALUES), sorted(ACTIVE_APPOINTMENT_STATUSES));
  assert.deepEqual(sorted(S.BOOKED_APPOINTMENT_STATUS_VALUES), sorted(BOOKED_APPOINTMENT_STATUSES));
});

test("estimate statuses: the estimates CHECK; awaiting decision = estimate-followups ACTIVE_STATUSES", () => {
  assert.deepEqual(sorted(S.ESTIMATE_STATUS_VALUES), sorted(checkList(read("supabase/migrations/20260918090924_add_estimates_table.sql"), "estimates")));
  assert.match(read("lib/automation/estimate-followups.ts"), /const ACTIVE_STATUSES: EstimateStatus\[\] = \["sent"\];/);
  assert.deepEqual([...S.AWAITING_DECISION_ESTIMATE_STATUS_VALUES], ["sent"]);
});

test("job statuses: the jobs CHECK; active = A3's set", () => {
  assert.deepEqual(sorted(S.JOB_STATUS_VALUES), sorted(checkList(read("supabase/migrations/20260918134457_add_jobs_table.sql"), "jobs")));
  assert.deepEqual(sorted(S.ACTIVE_JOB_STATUS_VALUES), sorted(ACTIVE_JOB_STATUSES));
});

test("invoice statuses: the invoices CHECK; unpaid = next-step's issue/collect statuses", () => {
  const sql = read("supabase/migrations/20260928162500_invoice_foundation.sql");
  const match = /status text not null default 'draft'\s*check \(status in \(([^)]*)\)\)/.exec(sql);
  assert.ok(match);
  assert.deepEqual(sorted(S.INVOICE_STATUS_VALUES), sorted(match![1].split(",").map((value) => value.trim().replace(/'/g, ""))));
  const nextStep = read("lib/people/next-step.ts");
  assert.match(nextStep, /liveInvoice\.status === "draft"/);
  assert.match(nextStep, /liveInvoice\.status === "sent" \|\| liveInvoice\.status === "partially_paid"/);
  assert.deepEqual(sorted(S.UNPAID_INVOICE_STATUS_VALUES), ["draft", "partially_paid", "sent"]);
});

test("review / referral statuses: lib/reviews-referrals/queries.ts; open = lifecycle-stage.ts RESOLVABLE_REVIEW_STATUSES", () => {
  assert.deepEqual(sorted(S.REVIEW_REQUEST_STATUS_VALUES), sorted(REVIEW_REQUEST_STATUSES.map((status) => status.value)));
  assert.deepEqual(sorted(S.REFERRAL_REQUEST_STATUS_VALUES), sorted(REFERRAL_REQUEST_STATUSES.map((status) => status.value)));
  assert.match(read("lib/customers/lifecycle-stage.ts"), /RESOLVABLE_REVIEW_STATUSES = new Set<ReviewRequest\["status"\]>\(\["requested", "responded"\]\)/);
  assert.deepEqual(sorted(S.OPEN_REVIEW_REQUEST_STATUS_VALUES), ["requested", "responded"]);
  assert.deepEqual(sorted(S.OPEN_REFERRAL_REQUEST_STATUS_VALUES), ["requested", "responded"]);
});

test("isKnown: only the listed values; null/undefined/other strings are unknown", () => {
  assert.equal(S.isKnown(S.JOB_STATUS_VALUES, "scheduled"), true);
  assert.equal(S.isKnown(S.JOB_STATUS_VALUES, "paused"), false);
  assert.equal(S.isKnown(S.JOB_STATUS_VALUES, null), false);
  assert.equal(S.isKnown(S.JOB_STATUS_VALUES, undefined), false);
});

test("B1 wires no consumer: nothing outside lib/lifecycle imports the canonical lifecycle model", () => {
  const MODEL = /lib\/lifecycle\/(stages|statuses|snapshot|snapshot-loader|derive)\b|from "\.\/(stages|statuses|snapshot|snapshot-loader|derive)"/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir))) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const relative = path.join(dir, entry);
      if (statSync(path.join(ROOT, relative)).isDirectory()) walk(relative);
      else if (/\.(ts|tsx)$/.test(entry) && !relative.startsWith(path.join("lib", "lifecycle")) && MODEL.test(readFileSync(path.join(ROOT, relative), "utf8"))) offenders.push(relative);
    }
  };
  for (const dir of ["app", "lib", "components"]) {
    try {
      walk(dir);
    } catch {
      /* a directory that does not exist */
    }
  }
  assert.deepEqual(offenders, []);
});
