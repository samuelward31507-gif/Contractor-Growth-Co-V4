/**
 * Minimal authorization tests for assertOrgAdmin(). This repository has no
 * committed test framework or test script (no vitest/jest, no `test` entry
 * in package.json) - rather than introducing a new dependency for one
 * function, this uses Node's built-in test runner (`node:test`/`node:assert`,
 * zero new packages) against a hand-rolled mock Supabase client. Run with:
 *
 *   node --test lib/automation/authorization.test.ts
 *
 * These are pure unit tests against a mock - they never touch a real
 * database, never create an organization/user/membership row, and are not a
 * substitute for exercising the real is_org_admin() RPC/RLS against actual
 * data (already covered by the Phase A schema audit and the existing
 * `services` table's identical, already-verified RLS shape). What this
 * *can* prove is assertOrgAdmin's own branching: does it call the RPC at
 * all, does it fail closed on every non-true result, and does it ever touch
 * agency_admins/is_agency_admin - it cannot prove what is_org_admin() itself
 * returns for a real agency admin or a real cross-org user, since those are
 * database facts, not something this function computes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

// This repo has no test runner/loader configured (no vitest/jest, no ts-node
// registration), so plain ESM `import` cannot resolve a TypeScript source
// file's extension the way tsc's own "bundler" moduleResolution does - and
// tsc separately rejects an import *specifier* that ends in `.ts` (TS5097)
// unless `allowImportingTsExtensions` is enabled, which this phase does not
// add to tsconfig. `require()` with an explicit `.ts` path sidesteps both:
// it's a runtime string, not a statically-checked module specifier, and
// Node's built-in TypeScript support (v23.6+) strips types from the
// required file directly. The `typeof import(...)` type-only query below
// (extensionless, exactly like every other import in this codebase) gives
// this file the same full type safety as a normal import would.
const require = createRequire(import.meta.url);
const { assertOrgAdmin }: typeof import("./authorization") = require("./authorization.ts");

type MockUser = { id: string } | null;
type MockRpcResult = { data: boolean | null; error: { message: string } | null };

function createMockSupabase(user: MockUser, rpcResult: MockRpcResult) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];

  const client = {
    auth: {
      getUser: async () => ({ data: { user } }),
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return rpcResult;
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222";

test("A: unauthenticated caller is rejected without ever calling is_org_admin", async () => {
  const { client, calls } = createMockSupabase(null, { data: null, error: null });

  const result = await assertOrgAdmin(client, ORG_ID);

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, "should fail closed on missing session before spending an RPC round trip");
});

test("B: an authenticated normal org member (is_org_admin -> false) is rejected", async () => {
  const { client } = createMockSupabase({ id: "member-user" }, { data: false, error: null });

  const result = await assertOrgAdmin(client, ORG_ID);

  assert.equal(result.ok, false);
});

test("C: an authenticated org owner/admin (is_org_admin -> true) is accepted", async () => {
  const { client } = createMockSupabase({ id: "admin-user" }, { data: true, error: null });

  const result = await assertOrgAdmin(client, ORG_ID);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.userId, "admin-user");
});

test("D: a user with no membership in the target org (is_org_admin -> false) is rejected, using the exact org id passed in", async () => {
  const { client, calls } = createMockSupabase({ id: "other-org-user" }, { data: false, error: null });

  const result = await assertOrgAdmin(client, OTHER_ORG_ID);

  assert.equal(result.ok, false);
  assert.equal(calls[0]?.args.target_org_id, OTHER_ORG_ID, "must check the exact organization being mutated, never a default/other org");
});

test("E: an agency admin with no owner/admin membership in this org is rejected the same way, and is_agency_admin is never consulted", async () => {
  // is_org_admin() only ever queries organization_members - it has no
  // awareness of agency_admins - so from assertOrgAdmin's point of view this
  // is the identical false-result code path as B/D. The meaningful
  // assertion here is the structural one: assertOrgAdmin never calls
  // anything named is_agency_admin, for any input.
  const { client, calls } = createMockSupabase({ id: "agency-admin-user" }, { data: false, error: null });

  const result = await assertOrgAdmin(client, ORG_ID);

  assert.equal(result.ok, false);
  assert.ok(
    calls.every((call) => call.fn === "is_org_admin"),
    "assertOrgAdmin must never call is_agency_admin or any other RPC",
  );
});

test("fails closed on an RPC error, not just on data === false (required: 'fail closed')", async () => {
  const { client } = createMockSupabase({ id: "admin-user" }, { data: null, error: { message: "connection reset" } });

  const result = await assertOrgAdmin(client, ORG_ID);

  assert.equal(result.ok, false);
});
