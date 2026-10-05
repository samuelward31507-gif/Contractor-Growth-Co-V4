/**
 * Agent Operating Layer, Phase 9 safety: structural guarantees, read from
 * the source itself so a later change that breaks one fails here.
 *
 *  - Agents cannot send anything: no file in the layer imports SMS, email,
 *    n8n, Twilio, Stripe, the outbound sender, or calls fetch - so there is
 *    no path around evaluateOutboundGate, and a TEST workspace cannot send
 *    through an agent because an agent cannot send at all.
 *  - Agents cannot bypass RLS: nothing imports the service-role client; the
 *    loader reads only through the request's own client.
 *  - Agents cannot reach another organization: the organization id comes
 *    from the verified membership, never the URL; the page is agency-admin
 *    only.
 *  - Agents change nothing: the only write in the layer is the optional,
 *    flag-gated agent_runs insert.
 *  - Analyzers are pure: they import no data-access module at runtime.
 *  - n8n, Twilio, Stripe, the outbound gate and applied migrations are
 *    untouched relative to the checkpoint.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agents/safety.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && entry.name !== "test-fixtures.ts" ? [rel] : [];
  });
}

const LAYER_FILES = [...sourceFiles("lib/agents"), ...sourceFiles("app/(app)/insights/intelligence")];
const importsOf = (source: string) => [...source.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)].map((m) => ({ typeOnly: Boolean(m[1]), specifier: m[2] }));

test("the layer has the files this test is guarding", () => {
  for (const f of ["lib/agents/runtime.ts", "lib/agents/load.ts", "lib/agents/persistence.ts", "lib/agents/agents/chief-of-staff.ts", "app/(app)/insights/intelligence/page.tsx"]) assert.ok(LAYER_FILES.includes(f), f);
});

test("no agent-layer file can send a message, call an integration or use the service role", () => {
  const forbidden = [/messaging\//, /automation\/(sms|n8n|n8n-retry|outbound-gate|manual-run|retry|executions)$/, /^twilio$/, /^stripe$/, /^resend$/, /lib\/email/, /lib\/payments/, /lib\/billing/, /supabase\/service$/, /notifications\//, /@anthropic-ai\/sdk/];
  for (const file of LAYER_FILES) {
    const source = read(file);
    for (const { specifier } of importsOf(source)) {
      assert.ok(!forbidden.some((re) => re.test(specifier)), `${file} imports ${specifier}`);
    }
    assert.doesNotMatch(source, /\bfetch\(/, `${file} calls fetch`);
    assert.doesNotMatch(source, /createServiceRoleClient|process\.env\.(SUPABASE_SERVICE_ROLE_KEY|N8N_|TWILIO|STRIPE|RESEND|ANTHROPIC)/, `${file} touches the service role or an integration secret`);
    assert.doesNotMatch(source, /^\s*["']use server["']/m, `${file} declares a server action`);
  }
});

test("the only database write is the flag-gated agent_runs insert", () => {
  for (const file of LAYER_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /\.(update|upsert|delete|rpc)\(/, `${file} writes or calls an RPC`);
    if (file !== "lib/agents/persistence.ts") assert.doesNotMatch(source, /\.insert\(/, `${file} inserts`);
  }
  const persistence = read("lib/agents/persistence.ts");
  assert.match(persistence, /\.from\("agent_runs"\)\.insert\(/);
  assert.match(persistence, /=== "on"/);
});

test("analyzers are pure: no runtime import of any data-access module", () => {
  for (const file of sourceFiles("lib/agents/agents")) {
    for (const { typeOnly, specifier } of importsOf(read(file))) {
      if (typeOnly) continue;
      const allowed = specifier.startsWith("../") || specifier.startsWith("./") || specifier === "zod" || specifier === "@/lib/ui/incident-language";
      assert.ok(allowed, `${file} imports ${specifier} at runtime`);
    }
    assert.doesNotMatch(read(file), /SupabaseClient|supabase\./, `${file} sees a database client`);
  }
  // The runtime hands an analyzer only its input and the clock.
  assert.match(read("lib/agents/runtime.ts"), /export type AgentAnalyzer<I> = \(input: I, context: \{ now: Date \}\)/);
});

test("the loader reads only existing read functions, through the caller's client", () => {
  const allowed = new Set(["@supabase/supabase-js", "@/lib/dashboard/queries", "@/lib/opportunities/intelligence", "@/lib/decisions/assemble", "@/lib/decisions/context", "@/lib/bi/metrics", "@/lib/automation-health/health", "@/lib/automation-health/queries", "@/lib/settings/queries", "./runtime", "./operating-layer", "./sources"]);
  for (const { specifier } of importsOf(read("lib/agents/load.ts"))) assert.ok(allowed.has(specifier), `load.ts imports ${specifier}`);
  // Market and prospecting sources are not connected: nothing is fetched or scraped.
  assert.match(read("lib/agents/load.ts"), /market_intelligence: \{ ok: true, data: \[\] \}/);
  assert.match(read("lib/agents/load.ts"), /prospecting: \{ ok: true, data: \[\] \}/);
});

test("the console is agency-admin only and scoped to the verified membership's organization", () => {
  const page = read("app/(app)/insights/intelligence/page.tsx");
  const gate = page.indexOf("isAgencyAdmin(supabase)");
  const loadCall = page.indexOf("loadSpecialistInputs(");
  assert.ok(gate > 0 && loadCall > gate, "the admin check runs before any agent data is loaded");
  assert.match(page, /notFound\(\)/);
  assert.match(page, /loadSpecialistInputs\(supabase, membership\.organizationId/);
  assert.doesNotMatch(page, /searchParams|params\b/, "no organization id or option is taken from the URL");
  assert.match(page, /if \(agentRunPersistenceEnabled\(\)\)/);
});

test("the agent_runs migration has one copy and is additive, append-only and agency-admin scoped", () => {
  // Lives in exactly one place: pending until a person applies it, then moved into migrations under its ledger version.
  const applied = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((name) => /^\d{14}_agent_runs\.sql$/.test(name));
  const pendingExists = fs.existsSync(path.join(ROOT, "supabase/pending/agent_runs.sql"));
  assert.equal(applied.length + (pendingExists ? 1 : 0), 1, "exactly one copy of the agent_runs migration");
  assert.ok(fs.existsSync(path.join(ROOT, "supabase/pending/agent_runs_rollback.sql")));
  const sql = read(pendingExists ? "supabase/pending/agent_runs.sql" : `supabase/migrations/${applied[0]}`);
  const statements = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(statements, /\b(alter table (?!public\.agent_runs)|drop table|drop function|create or replace function|truncate|delete from|update public)/i);
  assert.doesNotMatch(statements, /for (update|delete|all)\b/i);
  assert.doesNotMatch(statements, /grant [^;]*(update|delete)[^;]* to authenticated/i);
  assert.match(statements, /revoke all on table public\.agent_runs from anon/);
  assert.equal((statements.match(/is_agency_admin\(\) and public\.is_org_member\(organization_id\)/g) ?? []).length, 2);
  assert.match(statements, /^begin;/m);
  assert.match(statements, /^commit;/m);
});

function changedSinceCheckpoint(): string[] | null {
  for (const ref of ["agent-layer-checkpoint-0", "origin/main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT, stdio: "ignore" });
      const base = execFileSync("git", ["merge-base", "HEAD", ref], { cwd: ROOT, encoding: "utf8" }).trim();
      const committed = execFileSync("git", ["diff", "--name-only", base], { cwd: ROOT, encoding: "utf8" });
      return committed.split("\n").filter(Boolean);
    } catch {
      continue;
    }
  }
  return null;
}

test("n8n, Twilio, Stripe, outbound gate, auth and applied migrations are untouched", (t) => {
  const changed = changedSinceCheckpoint();
  if (changed === null) {
    t.skip("no git checkpoint available in this checkout");
    return;
  }
  const protectedPaths = [/^app\/api\//, /^lib\/automation\//, /^lib\/messaging\//, /^lib\/payments\//, /^lib\/billing\//, /^lib\/auth\//, /^lib\/supabase\//, /^supabase\/migrations\//, /^proxy\.ts$/, /^vercel\.json$/];
  const touched = changed.filter((file) => protectedPaths.some((re) => re.test(file)));
  assert.deepEqual(touched, []);
});
