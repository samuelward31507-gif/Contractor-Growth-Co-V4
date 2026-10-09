/**
 * Agency client delivery wiring and boundaries - verified against source (no
 * DOM test environment). Behavior: lib/agency/delivery.test.ts,
 * lib/agency/delivery-queries.test.ts, app/agency/delivery/actions.test.ts;
 * database rules: supabase/pending/scratch/validate-agency-client-delivery.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/agency/delivery/delivery.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ACTIONS = read("app/agency/delivery/actions.ts");
const QUERIES = read("lib/agency/delivery-queries.ts");
const LOGIC = read("lib/agency/delivery.ts");
const OVERVIEW = read("app/agency/delivery/page.tsx");
const DETAIL = read("app/agency/delivery/[id]/page.tsx");
const CONTROLS = read("app/agency/delivery/_components/delivery-controls.tsx");
const MIGRATION = read("supabase/pending/agency_client_delivery.sql");
const ROLLBACK = read("supabase/pending/agency_client_delivery_rollback.sql");
const ALL = [ACTIONS, QUERIES, LOGIC, OVERVIEW, DETAIL, CONTROLS].map(code).join("\n");

test("every write: admin check on the session first, then one database function on that same session", () => {
  assert.match(ACTIONS, /async function adminSession\(\) \{\n  const supabase = await createClient\(\);\n  return \(await isAgencyAdmin\(supabase\)\) \? supabase : null;\n\}/);
  const callBody = ACTIONS.slice(ACTIONS.indexOf("async function call("), ACTIONS.indexOf("/** Starts onboarding"));
  assert.ok(callBody.indexOf("if (!supabase) return NOT_AUTHORIZED;") < callBody.indexOf("supabase.rpc(fn, args)"));
  const exported = [...ACTIONS.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ["addServices", "addTask", "approveLaunch", "linkOrganization", "markReadyToLaunch", "moveToOngoing", "setClientDetails", "setTaskDetails", "setTaskStatus", "startOnboarding"]);
  for (const name of exported.filter((n) => n !== "approveLaunch")) {
    const body = ACTIONS.slice(ACTIONS.indexOf(`export async function ${name}(`)).split(/\nexport async function /)[0];
    assert.match(body, /return call\(clientId, "agency_\w+"/, `${name} goes through call()`);
    assert.doesNotMatch(body, /\.rpc\(|createServiceRoleClient/, `${name} has no other database path`);
  }
  const approve = ACTIONS.slice(ACTIONS.indexOf("export async function approveLaunch("));
  const check = approve.indexOf("if (!supabase) return NOT_AUTHORIZED;");
  assert.ok(check > 0 && check < approve.indexOf("getDeliveryClient(") && check < approve.indexOf("createServiceRoleClient()"), "admin check before any read, service-role or not");
  assert.match(approve, /return call\(clientId, "agency_approve_launch"/);
});

test("launch evidence is built on the server; the browser sends only the acknowledgement and a request id", () => {
  const approve = ACTIONS.slice(ACTIONS.indexOf("export async function approveLaunch("));
  assert.match(approve, /const checks = readinessChecks\(client, tasks, signals\);/);
  assert.match(approve, /p_evidence: \{ checks, unverified_acknowledgement: acknowledgement \|\| null \}/);
  assert.match(approve, /input: \{ requestId: unknown; expectedUpdatedAt: unknown; acknowledgement\?: unknown \}/);
  assert.equal(CONTROLS.match(/approveLaunch\(/g)?.length, 1, "one place approves");
  assert.match(CONTROLS, /approveLaunch\(client\.id, \{ requestId, expectedUpdatedAt: client\.updatedAt, acknowledgement: ack \}\)/);
  assert.match(CONTROLS, /const \[requestId\] = useState\(\(\) => crypto\.randomUUID\(\)\);/);
  assert.match(CONTROLS, /disabled=\{isPending \|\| blocked \|\| \(needsAck && ack\.trim\(\)\.length < 10\)\}/);
  assert.match(CONTROLS, /It doesn&rsquo;t turn on Go Live in Trackpr, resume automation or send anything\./);
});

test("no service-role write anywhere; the service client only reads, and only after the admin check", () => {
  assert.doesNotMatch(ALL, /\.(insert|update|upsert|delete)\(/, "every write is a database function on the session client");
  assert.doesNotMatch(code(QUERIES), /service\.rpc\(/);
  assert.match(QUERIES, /if \(!\(await isAgencyAdmin\(sessionSupabase\)\)\) return \{ ok: false, reason: "not_agency_admin" \};\n  const \[clients, tasks\]/);
  assert.match(QUERIES, /if \(!\(await isAgencyAdmin\(sessionSupabase\)\)\) return \{ ok: false, reason: "not_agency_admin" \};\n  const \[client, tasks, events, launch, admins\]/);
  // getLinkedSignals reads nothing else until the organization is confirmed Agency-managed.
  const signals = QUERIES.slice(QUERIES.indexOf("export async function getLinkedSignals("), QUERIES.indexOf("export async function getLinkableOrganizations("));
  const managed = signals.indexOf('service.from("agency_organizations")');
  assert.ok(managed > 0);
  assert.ok(signals.indexOf("if (!managed.data) return") < signals.indexOf("getOrganizationHealth("));
  assert.ok(signals.indexOf("if (managed.error) return") < signals.indexOf("getOrganizationHealth("));
  // The detail page creates the service client only after the admin-checked read succeeded.
  assert.ok(DETAIL.indexOf("getDeliveryClient(supabase, id)") < DETAIL.indexOf("createServiceRoleClient()"));
  assert.ok(DETAIL.indexOf("if (!result.ok) {") < DETAIL.indexOf("createServiceRoleClient()"));
  assert.doesNotMatch(code(OVERVIEW), /createServiceRoleClient/, "the overview reads nothing cross-organization");
});

test("nothing sends, bills, goes live, unpauses, or adds an Agency-managed organization", () => {
  assert.doesNotMatch(ALL, /twilio|sendSms|sendEmail|n8n|stripe\.|set_organization_automation_paused|automation_mode|updateAutomationMode|goLive\(/i);
  assert.doesNotMatch(ALL, /from\("(contacts|leads|customers|organization_members|revenue_events)"\)/);
  const sql = code(MIGRATION.replace(/--.*$/gm, ""));
  assert.doesNotMatch(sql, /insert into public\.(organizations|agency_organizations|agency_admins)/i);
  assert.doesNotMatch(sql, /update public\.(organizations|agency_organizations|founder_deals|agency_client_handoffs)\b/i);
  assert.doesNotMatch(sql, /automation_paused|automation_mode/i);
  assert.match(sql, /not exists \(select 1 from public\.agency_organizations o where o\.organization_id = p_organization_id\)/, "linking is limited to Agency-managed organizations");
  assert.match(CONTROLS, /Only accounts already managed by the Agency are offered/);
});

test("terms and scope stay read-only: no action or function changes them", () => {
  assert.doesNotMatch(code(ACTIONS), /p_(scope|setup_fee|monthly_fee|currency|name|contact)/);
  assert.match(MIGRATION, /raise exception 'the confirmed terms and scope can''t be changed' using errcode = 'FS422';/);
  assert.match(DETAIL, /title="Agreed terms" description="From the confirmed handoff\. Read-only\."/);
});

test("Founder access does not grant Agency delivery access; the founder area never reads delivery tables", () => {
  const founderFiles = fs
    .readdirSync(path.join(process.cwd(), "lib/founder"))
    .map((f) => `lib/founder/${f}`)
    .concat(walk("app/founder"));
  for (const f of founderFiles.filter((x) => /\.(ts|tsx)$/.test(x))) assert.doesNotMatch(code(read(f)), /agency_client_(tasks|events|launches)|agency\/delivery/, f);
  assert.match(MIGRATION, /create policy %I on public\.%I for select to authenticated using \(public\.is_agency_admin\(\)\)/);
});

test("honest health: unlinked/unreadable never healthy; last verified healthy is not invented; pause is changed only on the account page", () => {
  assert.match(DETAIL, /Last verified healthy: Not recorded/);
  assert.match(DETAIL, /href=\{`\/agency\/organizations\/\$\{live\.signals\.organizationId\}`\}/);
  assert.match(DETAIL, /live = \{ signals: client\.organizationId \? \{ kind: "unavailable", organizationId: client\.organizationId \} : \{ kind: "not_linked" \}, incidents: null \};/);
  assert.match(LOGIC, /const UNLINKED = "Unverified - no Trackpr account linked";/);
  assert.doesNotMatch(code(DETAIL), /AutomationPauseControl/);
});

test("pages: unauthorized and error states are distinct; reads are bounded", () => {
  assert.match(OVERVIEW, /result\.reason === "not_agency_admin" \? <UnauthorizedState \/> : <ErrorState retryHref="\/agency\/delivery" \/>/);
  assert.match(DETAIL, /result\.reason === "not_agency_admin" \? <UnauthorizedState \/> : <ErrorState retryHref=\{`\/agency\/delivery\/\$\{id\}`\} \/>/);
  for (const limit of ["MAX_CLIENT_ROWS", "MAX_TASK_ROWS", "MAX_EVENT_ROWS"]) assert.match(QUERIES, new RegExp(`\\.limit\\(${limit}\\)`));
});

test("rollback keeps every table, row and history by default", () => {
  const active = ROLLBACK.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(active, /drop table|delete from|truncate|update public\.|drop column|alter table .* drop/i);
  assert.match(ROLLBACK, /NOT RUN BY DEFAULT/);
});

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
}
