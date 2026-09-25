/**
 * Pass 3 (Revenue Intelligence Foundation): tests for the opportunities
 * migration (supabase/migrations/20260925020000_opportunities.sql) itself.
 *
 * Two parts, matching supabase/migrations/blocked-time-migration.test.ts's
 * own established split for a not-yet-applied migration:
 *
 * 1. A structural check of the migration's own SQL text (dedup index,
 *    lifecycle CHECK constraints, RLS/payment-gate policy shape) - runs
 *    now, no database required.
 *
 * 2. A LIVE, real-authenticated-session proof of cross-org isolation -
 *    modeled on lib/auth/payment-gate-rls.integration.test.ts's own
 *    real-minted-user-session technique (a service-role client cannot
 *    prove RLS at all, since it bypasses RLS by design - only a real
 *    authenticated PostgREST request through the anon key can). REQUIRES
 *    the migration to have actually been applied first; as of this pass it
 *    has not (see this repo's own PROGRESS_NOTES/final report) - these
 *    tests assert the DESIRED, already-implemented behavior and are
 *    expected to fail with "relation does not exist" until the migration
 *    is applied, at which point this suite should go green with no other
 *    changes required.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "supabase/migrations/opportunities-migration.test.ts"
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const MIGRATION_PATH = path.join(REPO_ROOT, "supabase/migrations/20260925020000_opportunities.sql");
const MIGRATION_SOURCE = fs.readFileSync(MIGRATION_PATH, "utf8");

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ==================== Part 1: structural (no database required) ====================

test("1. organization_id is a real FK with cascade delete - matching blocked_time/appointments' own shape", () => {
  assert.match(MIGRATION_SOURCE, /organization_id uuid not null references public\.organizations\(id\) on delete cascade/);
});

test("2. the type CHECK constraint lists exactly the 5 types this pass actually implements - not the full candidate list from the audit", () => {
  assert.match(
    MIGRATION_SOURCE,
    /type text not null check \(type in \(\s*'qualified_lead_unbooked',\s*'stale_estimate',\s*'completed_appointment_no_estimate',\s*'dormant_customer',\s*'no_show'\s*\)\)/,
  );
});

test("3. the status CHECK constraint is exactly open/resolved/dismissed - no 'acknowledged' state (see the migration's own lifecycle rationale)", () => {
  assert.match(MIGRATION_SOURCE, /status text not null default 'open' check \(status in \('open', 'resolved', 'dismissed'\)\)/);
});

test("4. resolved_at can only be set alongside a terminal status - never left set on a reopened/open row", () => {
  assert.match(MIGRATION_SOURCE, /check \(resolved_at is null or status in \('resolved', 'dismissed'\)\)/);
});

test("5. the dedup partial unique index is scoped to (organization_id, type, source_entity_id) WHERE status = 'open' - only one open opportunity per real condition at a time, never permanently blocking re-detection after resolution", () => {
  assert.match(MIGRATION_SOURCE, /create unique index if not exists opportunities_org_type_source_open_unique\s*\n\s*on public\.opportunities \(organization_id, type, source_entity_id\)\s*\n\s*where status = 'open'/);
});

test("6. RLS is enabled, and select/insert/update/delete policies all gate on is_org_member() - member-level, matching blocked_time, not admin-only", () => {
  assert.match(MIGRATION_SOURCE, /alter table public\.opportunities enable row level security/);
  for (const op of ["select", "insert", "update", "delete"]) {
    assert.match(MIGRATION_SOURCE, new RegExp(`create policy opportunities_${op} on public\\.opportunities for ${op} to authenticated`), `expected a member-scoped ${op} policy`);
    assert.match(MIGRATION_SOURCE, new RegExp(`create policy opportunities_${op} on public\\.opportunities[\\s\\S]*?is_org_member\\(organization_id\\)`), `expected policy ${op} to gate on is_org_member`);
  }
});

test("7. the payment-gate RESTRICTIVE policy reuses organization_payment_active() verbatim - the same function every other ordinary business-data table relies on", () => {
  assert.match(MIGRATION_SOURCE, /create policy opportunities_payment_active on public\.opportunities as restrictive for all to public/);
  assert.match(MIGRATION_SOURCE, /using \(public\.organization_payment_active\(organization_id\)\)/);
  assert.match(MIGRATION_SOURCE, /with check \(public\.organization_payment_active\(organization_id\)\)/);
});

test("8. the updated_at trigger is idempotent (drop trigger if exists, then create) - safe to rerun, matching blocked_time's own replay-safety fix", () => {
  assert.match(MIGRATION_SOURCE, /drop trigger if exists set_opportunities_updated_at on public\.opportunities/);
  assert.match(MIGRATION_SOURCE, /create trigger set_opportunities_updated_at\s*\n\s*before update on public\.opportunities/);
});

test("9. contact_id uses ON DELETE SET NULL, not RESTRICT - deleting a contact must never be blocked by its own opportunity history", () => {
  assert.match(MIGRATION_SOURCE, /contact_id uuid references public\.contacts\(id\) on delete set null/);
});

test("10. the one new index this pass adds targets jobs(organization_id, status, completed_at) - the dormant-customer detector's actual query shape, not a speculative index", () => {
  assert.match(MIGRATION_SOURCE, /create index if not exists idx_jobs_status_completed_at on public\.jobs \(organization_id, status, completed_at desc\)/);
});

// ==================== Part 2: LIVE cross-org RLS proof ====================
// Requires the migration to be applied. See this file's own header.

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createSessionFor(email: string, password: string) {
  const { data: signIn, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !signIn.session) throw error ?? new Error("no session");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
}

// Scoped in its own describe() so a before() failure here (e.g. the
// migration not applied yet) never takes down Part 1's structural tests
// above, which must keep running regardless.
describe("LIVE: opportunities cross-org RLS proof (requires the migration applied)", () => {
  let orgA: string;
  let orgB: string;
  let userAId: string;
  let sessionA: Awaited<ReturnType<typeof createSessionFor>>;
  let opportunityBId: string;

  before(async () => {
    const { data: a, error: aErr } = await service.from("organizations").insert({ name: "Opportunities RLS Test Org A", payment_status: "active" }).select("id").single();
    if (aErr) throw aErr;
    orgA = a!.id;

    const { data: b, error: bErr } = await service.from("organizations").insert({ name: "Opportunities RLS Test Org B", payment_status: "active" }).select("id").single();
    if (bErr) throw bErr;
    orgB = b!.id;

    const emailA = `opportunities-rls-a-${Date.now()}@example.com`;
    const password = "a-real-test-password-123";
    const { data: userA, error: userAErr } = await service.auth.admin.createUser({ email: emailA, password, email_confirm: true });
    if (userAErr) throw userAErr;
    userAId = userA.user!.id;
    const { error: memberAErr } = await service.from("organization_members").insert({ organization_id: orgA, user_id: userAId, role: "owner" });
    if (memberAErr) throw memberAErr;

    sessionA = await createSessionFor(emailA, password);

    const { data: oppB, error: oppBErr } = await service
      .from("opportunities")
      .insert({ organization_id: orgB, type: "no_show", status: "open", source_entity_type: "appointment", source_entity_id: "00000000-0000-0000-0000-000000000001", title: "Org B opportunity" })
      .select("id")
      .single();
    if (oppBErr) throw oppBErr;
    opportunityBId = oppB!.id;
  });

  after(async () => {
    await service.from("opportunities").delete().in("organization_id", [orgA, orgB]);
    await service.from("organization_members").delete().eq("user_id", userAId);
    await service.auth.admin.deleteUser(userAId);
    await service.from("organizations").delete().in("id", [orgA, orgB]);
  });

  test("11. LIVE: organization A's authenticated session cannot SELECT organization B's opportunity", async () => {
    const { data, error } = await sessionA.from("opportunities").select("id").eq("id", opportunityBId);
    assert.equal(error, null, "RLS denies by returning zero rows, not a query error");
    assert.equal(data?.length ?? 0, 0, "organization B's opportunity must never be visible to organization A's session");
  });

  test("12. LIVE: organization A's authenticated session cannot UPDATE organization B's opportunity (e.g. dismiss it)", async () => {
    const { data } = await sessionA.from("opportunities").update({ status: "dismissed" }).eq("id", opportunityBId).select("id");
    assert.equal(data?.length ?? 0, 0, "the update must affect zero rows under RLS");

    const { data: stillOpen } = await service.from("opportunities").select("status").eq("id", opportunityBId).single();
    assert.equal(stillOpen!.status, "open", "organization B's opportunity must remain untouched");
  });

  test("13. LIVE: organization A's authenticated session cannot INSERT an opportunity into organization B", async () => {
    const { error } = await sessionA
      .from("opportunities")
      .insert({ organization_id: orgB, type: "no_show", status: "open", source_entity_type: "appointment", source_entity_id: "00000000-0000-0000-0000-000000000002", title: "Attempted cross-org insert" });
    assert.ok(error, "inserting into another organization must be rejected by RLS, not silently succeed");
  });

  test("14. LIVE: organization A's authenticated session CAN insert and read its own organization's opportunity - RLS is scoping, not blanket-denying", async () => {
    const { data: inserted, error: insertError } = await sessionA
      .from("opportunities")
      .insert({ organization_id: orgA, type: "dormant_customer", status: "open", source_entity_type: "contact", source_entity_id: "00000000-0000-0000-0000-000000000003", title: "Own-org opportunity" })
      .select("id")
      .single();
    assert.equal(insertError, null);

    const { data: readBack } = await sessionA.from("opportunities").select("id, title").eq("id", inserted!.id).single();
    assert.equal(readBack?.title, "Own-org opportunity");
  });

  test("15. LIVE: the partial unique index rejects a second OPEN opportunity for the same (org, type, source_entity_id) - the real dedup backstop, not just application logic", async () => {
    const row = { organization_id: orgA, type: "no_show" as const, status: "open" as const, source_entity_type: "appointment" as const, source_entity_id: "00000000-0000-0000-0000-000000000004", title: "Dedup test" };
    const { error: firstError } = await service.from("opportunities").insert(row);
    assert.equal(firstError, null);

    const { error: secondError } = await service.from("opportunities").insert(row);
    assert.ok(secondError, "a second OPEN row for the identical (organization_id, type, source_entity_id) must be rejected");
    assert.equal(secondError!.code, "23505");
  });
});
