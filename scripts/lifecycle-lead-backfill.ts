/**
 * Phase 2B one-off: backfill missing lead links on estimates and jobs
 * (rules in lib/lifecycle/lead-backfill.ts). TEST project ONLY - refuses
 * any other Supabase URL. Dry-run by default; writes only with
 * --execute-test, and every write is guarded by `lead_id IS NULL` so it can
 * never overwrite a link and re-running is a no-op.
 *
 *   node --import ./lib/automation/test-loader.mjs scripts/lifecycle-lead-backfill.ts            # dry run
 *   node --import ./lib/automation/test-loader.mjs scripts/lifecycle-lead-backfill.ts --execute-test
 */
import { createRequire } from "node:module";
import path from "node:path";
import { planLeadBackfill, type BackfillEstimate, type BackfillJob, type BackfillLead } from "@/lib/lifecycle/lead-backfill";

const TEST_PROJECT_REF = "lwofqffxagxiqodqvcfr";
const PRODUCTION_PROJECT_REF = "mywznmxtlgajnczjvbmk";
const PAGE = 1000;
const MAX_ROWS = 50_000;

const require = createRequire(path.join(process.cwd(), "package.json"));
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!url.includes(TEST_PROJECT_REF) || url.includes(PRODUCTION_PROJECT_REF)) {
  console.error("Refusing to run: this backfill is for the TEST project only.");
  process.exit(1);
}
const execute = process.argv.includes("--execute-test");
const { createClient } = require("@supabase/supabase-js");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function readAll<T>(table: string, columns: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return rows;
    if (rows.length >= MAX_ROWS) throw new Error(`${table}: more than ${MAX_ROWS} rows - refusing to plan on a partial read`);
  }
}

const [leads, estimates, jobs] = await Promise.all([
  readAll<BackfillLead>("leads", "id, contact_id, created_at"),
  readAll<BackfillEstimate>("estimates", "id, contact_id, lead_id, created_at"),
  readAll<BackfillJob>("jobs", "id, contact_id, lead_id, estimate_id, created_at"),
]);
const plan = planLeadBackfill({ leads, estimates, jobs });

console.log(JSON.stringify({ project: "TEST", mode: execute ? "execute" : "dry-run", read: { leads: leads.length, estimates: estimates.length, jobs: jobs.length }, counts: plan.counts }, null, 2));

if (!execute) process.exit(0);

let estimatesWritten = 0;
let jobsWritten = 0;
for (const update of plan.estimateUpdates) {
  const { data, error } = await db.from("estimates").update({ lead_id: update.lead_id }).eq("id", update.id).is("lead_id", null).select("id");
  if (error) throw new Error(`estimate ${update.id}: ${error.message}`);
  estimatesWritten += data?.length ?? 0;
}
for (const update of plan.jobUpdates) {
  const { data, error } = await db.from("jobs").update({ lead_id: update.lead_id }).eq("id", update.id).is("lead_id", null).select("id");
  if (error) throw new Error(`job ${update.id}: ${error.message}`);
  jobsWritten += data?.length ?? 0;
}
console.log(JSON.stringify({ written: { estimates: estimatesWritten, jobs: jobsWritten } }));
