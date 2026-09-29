/**
 * Phase 2E: the Dashboard's record attention (leads / appointments /
 * estimates) comes from dashboard_record_attention on /today only; Agency
 * keeps the legacy reads. Parity itself is proved by
 * supabase/pending/scratch/validate-dashboard-sql.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/record-attention.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("/today's memoized loader uses both SQL attention paths; the default stays legacy", () => {
  const queries = read("lib/dashboard/queries.ts");
  assert.match(queries, /export const getDashboardSqlData = cache\(\(supabase: SupabaseClient, organizationId: string\) => getDashboardData\(supabase, organizationId, \{ conversationAttention: "sql", recordAttention: "sql" \}\)\);/);
  assert.match(queries, /const sqlRecordAttention = options\.recordAttention === "sql";/);
  assert.match(read("app/(app)/today/page.tsx"), /getDashboardSqlData\(supabase, membership\.organizationId\)/);
});

test("Agency still calls getDashboardData with the legacy defaults", () => {
  assert.match(read("app/agency/organizations/[id]/page.tsx"), /getDashboardData\(service, id\),/);
  assert.match(read("lib/agency/operations.ts"), /getDashboardData\(serviceSupabase, organizationId\);/);
});

test("the high-value threshold keeps one source of truth", () => {
  assert.match(read("lib/dashboard/queries.ts"), /getDashboardRecordAttention\(supabase, organizationId, HIGH_VALUE_THRESHOLD\)/);
  const migration = read("supabase/pending/dashboard_attention_sql.sql");
  assert.doesNotMatch(migration, />= 5000/, "the threshold is a parameter, never a literal in SQL");
  assert.match(migration, /l\.estimated_value >= p_high_value_threshold/);
});

test("dashboard_attention_sql.sql is SECURITY INVOKER, STABLE, org-filtered, and changes no policy or index", () => {
  const migration = read("supabase/pending/dashboard_attention_sql.sql");
  assert.match(migration, /language sql\nstable\nsecurity invoker\nset search_path = public/);
  assert.doesNotMatch(migration, /security definer|create policy|alter policy|drop policy|create index|alter table/i);
  assert.match(migration, /revoke all on function public\.dashboard_record_attention\(uuid, timestamptz, numeric\) from anon;/);
  assert.match(migration, /grant execute on function public\.dashboard_record_attention\(uuid, timestamptz, numeric\) to authenticated;/);
  for (const table of ["appointments", "leads", "estimates", "opportunities"]) {
    const reads = migration.match(new RegExp(`from public\\.${table} (\\w+)`, "g")) ?? [];
    assert.ok(reads.length > 0, `${table} is read`);
  }
  const unfiltered = [...migration.matchAll(/from public\.(appointments|leads|estimates|opportunities) (\w+)\n?[^;]*?where (\w+)\.organization_id = p_organization_id/g)];
  assert.ok(unfiltered.length >= 10, "every top-level read filters organization_id explicitly");
});
