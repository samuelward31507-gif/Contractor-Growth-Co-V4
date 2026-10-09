/**
 * Agency handoff actions (app/agency/handoffs/actions.ts): the agency-admin
 * check runs on the caller's own session before any database call; input is
 * validated first; database refusals become clear messages without leaking
 * internals; a repeated confirm reports the same client. The database rules
 * themselves are proven by supabase/pending/scratch/validate-agency-client-handoff.mjs.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/agency/handoffs/actions.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;
const H = "11111111-1111-4111-8111-111111111111";
let admin = true;
let calls: { name: string; args: unknown }[] = [];
let response: { data: unknown; error: unknown } = { data: null, error: null };
const session = { rpc: async (name: string, args: unknown) => (calls.push({ name, args }), response) };

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => session } });
mock.module(lib("lib/agency/queries.ts"), { namedExports: { isAgencyAdmin: async (client: unknown) => client === session && admin } });
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
const actions = await import(lib("app/agency/handoffs/actions.ts"));

beforeEach(() => {
  admin = true;
  calls = [];
  response = { data: null, error: null };
});

test("a non-admin is refused before any database call", async () => {
  admin = false;
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: false, error: "Not authorized." });
  assert.deepEqual(await actions.cancelAgencyClientHandoff(H, "reason"), { ok: false, error: "Not authorized." });
  assert.deepEqual(calls, []);
});

test("input is validated before the admin check and the database", async () => {
  assert.equal((await actions.confirmClientHandoff("not-a-uuid")).ok, false);
  assert.equal((await actions.cancelAgencyClientHandoff(H, "   ")).ok, false);
  assert.equal((await actions.cancelAgencyClientHandoff(H, "x".repeat(501))).ok, false);
  assert.deepEqual(calls, []);
});

test("confirm: calls the database function once per request; a repeat returns the same client", async () => {
  response = { data: { status: "confirmed", agency_client_id: "c1" }, error: null };
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: true, status: "confirmed", agencyClientId: "c1" });
  response = { data: { status: "duplicate", agency_client_id: "c1" }, error: null };
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: true, status: "duplicate", agencyClientId: "c1" });
  assert.deepEqual(calls, [
    { name: "agency_confirm_client_handoff", args: { p_handoff_id: H } },
    { name: "agency_confirm_client_handoff", args: { p_handoff_id: H } },
  ]);
});

test("confirm: stale, cancelled and duplicate-client refusals read clearly; internals never leak", async () => {
  response = { data: null, error: { code: "FS409", message: "the deal changed since this handoff was prepared - cancel it and prepare a new one" } };
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: false, error: "The deal changed since this handoff was prepared - cancel it and prepare a new one." });
  response = { data: null, error: { code: "FS409", message: "an Agency client already exists for this deal" } };
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: false, error: "An Agency client already exists for this deal." });
  response = { data: null, error: { code: "FS404", message: "handoff not found" } };
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: false, error: "That handoff could not be found." });
  response = { data: null, error: { code: "XX000", message: "relation secret_internal_table" } };
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: false, error: "We couldn't complete that. Please try again - a retry never creates a second client." });
  response = { data: null, error: { code: "PGRST202", message: "x" } };
  assert.deepEqual(await actions.confirmClientHandoff(H), { ok: false, error: "Client handoff isn't enabled on this database yet." });
});

test("cancel: trimmed reason passed through; a confirmed handoff can't be cancelled", async () => {
  response = { data: { status: "cancelled" }, error: null };
  assert.deepEqual(await actions.cancelAgencyClientHandoff(H, "  Client asked to wait "), { ok: true, status: "cancelled", agencyClientId: null });
  assert.deepEqual(calls[0], { name: "cancel_client_handoff", args: { p_handoff_id: H, p_reason: "Client asked to wait" } });
  response = { data: null, error: { code: "FS422", message: "this handoff is confirmed - the Agency client already exists" } };
  assert.deepEqual(await actions.cancelAgencyClientHandoff(H, "x"), { ok: false, error: "This handoff is confirmed - the Agency client already exists." });
});
