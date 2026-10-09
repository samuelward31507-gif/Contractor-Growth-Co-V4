/**
 * Deal-to-client handoff wiring and boundaries - verified against source (no
 * DOM test environment). Behavior: lib/founder/handoff.test.ts,
 * app/founder/actions.test.ts, app/agency/handoffs/actions.test.ts; database
 * rules: supabase/pending/scratch/validate-agency-client-handoff.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/agency/handoffs/handoffs.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const PAGE = read("app/agency/handoffs/page.tsx");
const AGENCY_LIB = read("lib/agency/handoffs.ts");
const AGENCY_ACTIONS = read("app/agency/handoffs/actions.ts");
const CONTROLS = read("app/agency/handoffs/_components/handoff-controls.tsx");
const PANEL = read("app/founder/_components/handoff-panel.tsx");
const DEALS = read("app/founder/deals/page.tsx");
const QUERIES = read("lib/founder/queries.ts");
const MIGRATION = read("supabase/pending/agency_client_handoff.sql");
const ROLLBACK = read("supabase/pending/agency_client_handoff_rollback.sql");
const NEW_CODE = [PAGE, AGENCY_LIB, AGENCY_ACTIONS, CONTROLS, PANEL, read("lib/founder/handoff.ts")].map(code).join("\n");

test("agency side: session client only, admin check first, unauthorized and error states distinct", () => {
  for (const src of [PAGE, AGENCY_LIB, AGENCY_ACTIONS]) assert.doesNotMatch(code(src), /createServiceRoleClient|service_role/, "no service-role client - RLS applies");
  assert.match(AGENCY_LIB, /if \(!\(await isAgencyAdmin\(sessionSupabase\)\)\) return \{ ok: false, reason: "not_agency_admin" \};\n  const \[handoffs, clients\]/);
  assert.match(PAGE, /result\.reason === "not_agency_admin" \? <UnauthorizedState \/> : <ErrorState retryHref="\/agency\/handoffs" \/>/);
  for (const name of ["confirmClientHandoff", "cancelAgencyClientHandoff"]) {
    const body = AGENCY_ACTIONS.slice(AGENCY_ACTIONS.indexOf(`export async function ${name}(`));
    const check = body.indexOf("if (!(await isAgencyAdmin(supabase))) return NOT_AUTHORIZED;");
    assert.ok(check > 0 && check < body.indexOf(".rpc("), `${name}: admin check before the database call`);
  }
  assert.match(AGENCY_LIB, /\.limit\(MAX_HANDOFF_ROWS\)/);
});

test("domains stay apart: no organizations, agency_organizations, contractor contacts/customers, Stripe or messaging touched", () => {
  assert.doesNotMatch(NEW_CODE, /from\("(organizations|agency_organizations|contacts|leads|customers|organization_members|revenue_events)"\)/);
  assert.doesNotMatch(NEW_CODE, /stripe|twilio|sendSms|sendEmail|n8n/i);
  const sql = code(MIGRATION.replace(/^--.*$/gm, ""));
  assert.doesNotMatch(sql, /insert into public\.(organizations|agency_organizations|contacts)|update public\.(organizations|founder_deals|founder_deal_activities)/i, "the migration never writes another domain");
  assert.match(MIGRATION, /organization_id uuid unique,/, "no Trackpr account link is created here");
});

test("two explicit steps: prepare (founder) creates no client; confirm (agency) is a separate reviewed action", () => {
  assert.match(PANEL, /Prepare client handoff/);
  assert.match(PANEL, /it doesn&rsquo;t create a client by itself/);
  assert.match(PANEL, /const \[requestId\] = useState\(\(\) => crypto\.randomUUID\(\)\);/);
  assert.doesNotMatch(PANEL, /confirmClientHandoff|agency_confirm/);
  assert.match(CONTROLS, /onClick=\{\(\) => setReviewing\(true\)\} className=\{primaryButtonAutoClass\}>\s*Review and confirm/, "the first click only opens the review");
  assert.equal(CONTROLS.match(/confirmClientHandoff\(handoff\.id\)/g)?.length, 1, "exactly one place creates the client");
  assert.ok(CONTROLS.indexOf("confirmClientHandoff(handoff.id)") > CONTROLS.indexOf("{reviewing ? ("), "and it is inside the review dialog");
  assert.match(CONTROLS, /run\(\(\) => confirmClientHandoff\(handoff\.id\), \(\) => setReviewing\(false\)\)/, "the create call lives only in the review dialog");
  assert.match(CONTROLS, /disabled=\{isPending\} onClick=\{\(\) => run\(\(\) => confirmClientHandoff/);
  assert.match(CONTROLS, /It doesn&rsquo;t create or change a Trackpr account, charge anything or contact the client\./);
});

test("founder deal page: status and missing info from the founder's own handoffs; load failure shown, not hidden", () => {
  assert.match(DEALS, /getFounderHandoffs\(supabase, userId\)/);
  assert.match(QUERIES, /from\("agency_client_handoffs"\)\.select\(HANDOFF_COLUMNS\)\.eq\("founder_owner_id", ownerId\)/);
  assert.doesNotMatch(code(QUERIES), /from\("agency_clients"\)/, "founder reads never touch Agency clients");
  assert.match(DEALS, /<LoadFailed what="This deal's client handoff" \/>/);
  assert.match(PANEL, /Before this deal can be handed to Agency delivery, add:/);
});

test("rollback keeps every table and row by default", () => {
  const active = ROLLBACK.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(active, /drop table|delete from|truncate|update public\./i);
  assert.match(ROLLBACK, /NOT RUN BY DEFAULT/);
});
