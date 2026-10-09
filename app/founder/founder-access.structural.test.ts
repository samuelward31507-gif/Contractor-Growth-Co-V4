/**
 * Founder Command Center access is enforced at every layer - not by hiding
 * navigation. Verified against source (no DOM test environment here).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/founder/founder-access.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

test("the layout 404s anyone who isn't an allow-listed founder and sends signed-out visitors to login", () => {
  const layout = read("app/founder/layout.tsx");
  assert.match(layout, /if \(!user\) redirect\("\/login"\);/);
  assert.match(layout, /const founder = await getFounderContext\(\);\s*if \(!founder\) notFound\(\);/);
  assert.match(layout, /robots: \{ index: false, follow: false \}/);
});

test("every founder page re-checks access itself", () => {
  for (const page of ["app/founder/page.tsx", "app/founder/tasks/page.tsx", "app/founder/deals/page.tsx", "app/founder/metrics/page.tsx", "app/founder/review/page.tsx"]) {
    assert.match(read(page), /await requireFounderPage\(\)/, page);
  }
  assert.match(read("app/founder/_components/page-parts.tsx"), /const ctx = await getFounderContext\(\);\s*if \(!ctx\) notFound\(\);/);
});

test("every exported server action resolves founder access before anything else", () => {
  const actions = read("app/founder/actions.ts");
  const exported = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(exported.length >= 12);
  for (const name of exported) {
    if (name === "quickCaptureFounderItem") continue; // delegates to createFounderItem
    const body = actions.slice(actions.indexOf(`export async function ${name}(`));
    assert.match(body.slice(0, 200), /const ctx = await founder\(\);\s*if \(!ctx\) return NOT_AVAILABLE;/, name);
  }
  // Every update/delete is scoped to the caller's own rows.
  // Every update/delete is scoped to the caller's own rows: the owner filter follows each write in the same statement.
  const writes = [...actions.matchAll(/\.(update|delete)\(/g)];
  assert.equal(writes.length, 10, "item update, complete, delete, move-to-day; deal update, delete; MRR delete; priority set, remove, re-rank (deal stages move only through the database functions)");
  for (const write of writes) {
    const statement = actions.slice(write.index, actions.indexOf(";", write.index));
    assert.match(statement, /\.eq\("owner_id", ctx\.userId\)/, `owner filter on: ${statement.slice(0, 80)}`);
  }
  // Sales history is written only through the founder_* database functions (which re-check the founder and the deal's owner).
  assert.deepEqual([...actions.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]).sort(), ["founder_change_deal_stage", "founder_log_deal_activity", "founder_void_deal_activity"]);
  assert.doesNotMatch(actions, /from\("founder_deal_activities"\)/, "no direct reads or writes of the history from actions");
});

test("access resolution fails closed, and founder access is separate from agency admin", () => {
  const access = read("lib/founder/access.ts");
  assert.match(access, /if \(error \|\| allowed !== true\) return null;/);
  assert.match(access, /return !error && data === true;/);
  assert.doesNotMatch(access, /is_agency_admin|agency_admins/);
  const sql = read("supabase/pending/founder_command_center.sql");
  assert.match(sql, /using \(owner_id = auth\.uid\(\) and public\.is_founder\(\)\) with check \(owner_id = auth\.uid\(\) and public\.is_founder\(\)\)/);
  assert.match(sql, /source text not null default 'manual' check \(source = 'manual'\)/);
  assert.doesNotMatch(sql, /create policy[^;]*founder_users[^;]*for (insert|update|delete|all)/i, "no self-service grant of founder access");
});

test("the agency shell shows the Founder group only to a verified founder; the client app is unchanged", () => {
  const agency = read("app/agency/layout.tsx");
  assert.match(agency, /const founder = await isFounder\(supabase\);\s*const groups = founder \? \[AGENCY_NAV_GROUP, FOUNDER_NAV_GROUP\] : \[AGENCY_NAV_GROUP\];/);
  assert.doesNotMatch(read("app/(app)/_components/nav-items.ts"), /founder/i);
});
