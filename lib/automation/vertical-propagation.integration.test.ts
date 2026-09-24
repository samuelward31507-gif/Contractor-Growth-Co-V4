/**
 * Gym Phase 2B.1: live proof that lead-followup.ts and customer-reply.ts
 * correctly resolve organizations.vertical and wire it into the
 * N8nWorkflowContract they build. triggerN8nWorkflow() has no test seam
 * (unlike sendOutboundMessage's sendSmsFn) and does a real outbound fetch,
 * so the actual bytes dispatched to n8n can't be intercepted from a test
 * without either a live n8n endpoint or changing these functions' public
 * signature - neither is in this slice's authorized scope. Instead, this
 * suite directly and live-tests resolveOrganizationVertical() - the exact
 * function each file's contract-building code assigns into
 * context.organization.vertical - against real disposable contractor/gym
 * organizations, which is the verifiable claim available without expanding
 * scope. Both files' copies are tested separately since each keeps its own
 * local copy (matching this codebase's own *AsService-adjacent-helper
 * convention).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/automation/vertical-propagation.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { resolveOrganizationVertical: resolveForLeadFollowup }: typeof import("./lead-followup") = require("./lead-followup.ts");
const { resolveOrganizationVertical: resolveForCustomerReply }: typeof import("./customer-reply") = require("./customer-reply.ts");

const REPO_ROOT = process.cwd();
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

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let contractorOrgId: string;
let gymOrgId: string;

before(async () => {
  const { data: contractorOrg } = await service.from("organizations").insert({ name: "Vertical Propagation Test Org - Contractor" }).select("id").single();
  contractorOrgId = contractorOrg!.id;

  const { data: gymOrg } = await service.from("organizations").insert({ name: "Vertical Propagation Test Org - Gym", vertical: "gym" }).select("id").single();
  gymOrgId = gymOrg!.id;
});

after(async () => {
  await service.from("organizations").delete().eq("id", contractorOrgId);
  await service.from("organizations").delete().eq("id", gymOrgId);
});

test("A. lead-followup.ts resolves a contractor organization's vertical as 'contractor'", async () => {
  const vertical = await resolveForLeadFollowup(service, contractorOrgId);
  assert.equal(vertical, "contractor");
});

test("B. lead-followup.ts resolves a gym organization's vertical as 'gym'", async () => {
  const vertical = await resolveForLeadFollowup(service, gymOrgId);
  assert.equal(vertical, "gym");
});

test("C. customer-reply.ts resolves a contractor organization's vertical as 'contractor'", async () => {
  const vertical = await resolveForCustomerReply(service, contractorOrgId);
  assert.equal(vertical, "contractor");
});

test("D. customer-reply.ts resolves a gym organization's vertical as 'gym'", async () => {
  const vertical = await resolveForCustomerReply(service, gymOrgId);
  assert.equal(vertical, "gym");
});

test("E. every pre-existing N8nWorkflowContract field is still present with its original type (source-level check)", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "lib/automation/n8n.ts"), "utf8");
  for (const field of [
    "version: 1;",
    "id: string;",
    "type: string;",
    "organization_id: string;",
    "entity_type: string | null;",
    "entity_id: string | null;",
    "payload: Record<string, unknown>;",
    "workflow_name: string;",
    "attempt: number;",
    "name: string;",
    "timezone: string;",
    "enabled: boolean;",
    "tone: string | null;",
    "business_introduction: string | null;",
    "general_instructions: string | null;",
    "first_name: string | null;",
    "last_name: string | null;",
    "phone: string | null;",
    "email: string | null;",
  ]) {
    assert.ok(source.includes(field), `expected N8nWorkflowContract source to still contain "${field}"`);
  }
  // The new field is additive and optional - proves it never forces every
  // other, untouched N8nWorkflowContract construction site (appointments.ts,
  // estimates.ts, jobs.ts, lead-nurture.ts, lead-reactivation.ts,
  // n8n-retry.ts, post-job-followup.ts) to change.
  assert.match(source, /vertical\?:\s*OrganizationVertical;/);
});

test("E2. lead-followup.ts actually wires the resolved vertical into both contract literals, not just resolving it unused", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "lib/automation/lead-followup.ts"), "utf8");
  const organizationBlocks = [...source.matchAll(/organization:\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.equal(organizationBlocks.length, 2, "expected exactly two contract organization blocks (emitLeadCreatedFollowup + emitLeadCreatedFollowupAsService)");
  for (const block of organizationBlocks) {
    assert.match(block, /\bvertical,?\b/, "expected the resolved `vertical` variable to be assigned into the contract's organization block");
  }
  // Both functions must resolve it via the same helper, not two divergent
  // implementations.
  assert.equal([...source.matchAll(/resolveOrganizationVertical\(supabase, input\.organizationId\)/g)].length, 2);
});

test("E3. customer-reply.ts actually wires the resolved vertical into its contract literal", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "lib/automation/customer-reply.ts"), "utf8");
  const organizationBlock = source.match(/organization:\s*\{[^}]*\}/);
  assert.ok(organizationBlock, "expected a contract organization block");
  assert.match(organizationBlock![0], /\bvertical,?\b/);
  assert.match(source, /resolveOrganizationVertical\(supabase, input\.organizationId\)/);
});

test("F. resolveOrganizationVertical fails closed to 'contractor' for an org with no vertical row match (defense against a bad id)", async () => {
  const vertical = await resolveForLeadFollowup(service, "00000000-0000-0000-0000-000000000000");
  assert.equal(vertical, "contractor");
});

test("G. organization isolation: resolving one organization's vertical never returns another organization's value", async () => {
  const contractorVertical = await resolveForLeadFollowup(service, contractorOrgId);
  const gymVertical = await resolveForLeadFollowup(service, gymOrgId);
  assert.notEqual(contractorVertical, gymVertical);
});
