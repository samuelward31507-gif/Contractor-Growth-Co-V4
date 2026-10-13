/**
 * The fail-closed test database guard (lib/automation/test-db-guard.mjs).
 * No database is contacted: identities are synthetic JWT-shaped keys and the
 * "network" is a spy fetch that records whether anything would have left the
 * process. Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/test-db-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const guard = await import(pathToFileURL(path.join(process.cwd(), "lib/automation/test-db-guard.mjs")).href);
const { evaluateTestRequest, installTestDatabaseGuard, AUTHORIZED_TEST_PROJECT_REF: TEST, PRODUCTION_PROJECT_REF: PROD, GUARD_ERROR_PREFIX } = guard;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A synthetic Supabase-style key: header.payload.signature with a `ref` claim. The signature part stands in for the secret. */
const key = (ref: string | null, secret = "SIGNATURE-SECRET-should-never-appear") => `${b64({ alg: "HS256" })}.${b64(ref ? { ref, role: "service_role" } : { role: "authenticated" })}.${secret}`;
const url = (ref: string) => `https://${ref}.supabase.co/rest/v1/leads`;
const UNKNOWN = "abcdefghijklmnopqrst";
const withKey = (k: string) => ({ apikey: k, Authorization: `Bearer ${k}` });

test("the loader installed the guard before this test module was loaded", () => {
  assert.equal((globalThis.fetch as unknown as { __trackprTestDbGuard?: boolean }).__trackprTestDbGuard, true);
});

test("1. the Production project is always rejected - by host or by key, whatever the target setting", () => {
  for (const target of ["test", "local", undefined]) {
    const env = { TRACKPR_INTEGRATION_TARGET: target };
    assert.equal(evaluateTestRequest(url(PROD), withKey(key(PROD)), env).allowed, false);
    assert.equal(evaluateTestRequest(url(TEST), withKey(key(PROD)), env).allowed, false, "a Production key sent to the TEST host");
    assert.equal(evaluateTestRequest("http://127.0.0.1:54321/rest/v1/leads", withKey(key(PROD)), env).allowed, false, "a Production key through a local proxy");
  }
  assert.match(evaluateTestRequest(url(PROD), withKey(key(PROD)), { TRACKPR_INTEGRATION_TARGET: "test" }).reason, /Production project/);
});

test("2. an unknown or unverifiable project is rejected", () => {
  const env = { TRACKPR_INTEGRATION_TARGET: "test" };
  assert.equal(evaluateTestRequest(url(UNKNOWN), withKey(key(UNKNOWN)), env).allowed, false, "another project");
  assert.equal(evaluateTestRequest(url(TEST), { apikey: "sb_secret_notajwt" }, env).allowed, false, "a non-JWT key cannot be verified");
  assert.equal(evaluateTestRequest(url(TEST), { apikey: "a.b" }, env).allowed, false, "malformed key");
  assert.equal(evaluateTestRequest(url(TEST), withKey(key(null)), env).allowed, false, "a key without a project ref");
  assert.equal(evaluateTestRequest("https://db.example.com/rest/v1/leads", { apikey: key(TEST) }, env).allowed, false, "a TEST key sent to some other host");
});

test("3. the TEST project is accepted only with the explicit target AND host AND key all identifying it", () => {
  assert.equal(evaluateTestRequest(url(TEST), withKey(key(TEST)), { TRACKPR_INTEGRATION_TARGET: "test" }).allowed, true);
  assert.equal(evaluateTestRequest(url(TEST), { apikey: key(TEST), Authorization: `Bearer ${key(null)}` }, { TRACKPR_INTEGRATION_TARGET: "test" }).allowed, true, "a user session token (no ref) with the TEST anon key");
  assert.equal(evaluateTestRequest(url(TEST), withKey(key(TEST)), {}).allowed, false, "no explicit target");
  assert.equal(evaluateTestRequest(url(TEST), { apikey: key(TEST), Authorization: `Bearer ${key(UNKNOWN)}` }, { TRACKPR_INTEGRATION_TARGET: "test" }).allowed, false, "a mismatched bearer key");
});

test("4. a local/disposable database is accepted only through TRACKPR_INTEGRATION_TARGET=local on a loopback host", () => {
  const local = "http://127.0.0.1:54321/rest/v1/leads";
  assert.equal(evaluateTestRequest(local, withKey(key(null)), { TRACKPR_INTEGRATION_TARGET: "local" }).allowed, true);
  assert.equal(evaluateTestRequest("http://localhost:54321/rest/v1/leads", { apikey: "anything" }, { TRACKPR_INTEGRATION_TARGET: "local" }).allowed, true);
  assert.equal(evaluateTestRequest(local, withKey(key(null)), {}).allowed, false, "a real (JWT) key on loopback without the explicit setting - a local database or a tunnel");
  assert.equal(evaluateTestRequest(local, { apikey: "sb_secret_abc" }, {}).allowed, false, "a new-style key on loopback without the setting");
  assert.equal(evaluateTestRequest(local, withKey(key(TEST)), {}).allowed, false, "a hosted project's key through a loopback tunnel");
  assert.equal(evaluateTestRequest(local, { apikey: "fake-anon-key-for-local-test-only" }, {}).allowed, true, "a test's own in-process fake server with a fake key is not a database");
  assert.equal(evaluateTestRequest(url(TEST), withKey(key(TEST)), { TRACKPR_INTEGRATION_TARGET: "local" }).allowed, false, "local mode never reaches a hosted project");
});

test("5. the guard refuses before any network I/O - a real supabase-js insert never reaches fetch", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    installTestDatabaseGuard({ TRACKPR_INTEGRATION_TARGET: "test" });
    const prod = createClient(`https://${PROD}.supabase.co`, key(PROD), { auth: { persistSession: false } });
    const { error } = await prod.from("leads").insert({ organization_id: "x" });
    assert.ok(error, "the insert failed");
    assert.match(String(error.message), new RegExp(GUARD_ERROR_PREFIX.replace(/[[\]]/g, "\\$&")));
    assert.equal(networkCalls, 0, "nothing left the process");

    const ok = createClient(`https://${TEST}.supabase.co`, key(TEST), { auth: { persistSession: false } });
    await ok.from("leads").select("id");
    assert.equal(networkCalls, 1, "the verified TEST project is allowed through");
  } finally {
    globalThis.fetch = original;
  }
});

test("6. refusal messages never contain a key, token or signature", async () => {
  const secret = "SIGNATURE-SECRET-should-never-appear";
  const cases: [string, Record<string, string>, Record<string, string | undefined>][] = [
    [url(PROD), withKey(key(PROD, secret)), { TRACKPR_INTEGRATION_TARGET: "test" }],
    [url(UNKNOWN), withKey(key(UNKNOWN, secret)), { TRACKPR_INTEGRATION_TARGET: "test" }],
    [url(TEST), { apikey: `sb_secret_${secret}` }, { TRACKPR_INTEGRATION_TARGET: "test" }],
    [url(TEST), withKey(key(TEST, secret)), {}],
  ];
  for (const [u, h, env] of cases) {
    const verdict = evaluateTestRequest(u, h, env);
    assert.equal(verdict.allowed, false);
    assert.doesNotMatch(verdict.reason, new RegExp(secret));
    assert.doesNotMatch(verdict.reason, /eyJ|Bearer|sb_secret/);
  }
});

test("7. missing or malformed configuration fails closed", () => {
  assert.equal(evaluateTestRequest(url(TEST), withKey(key(TEST)), {}).allowed, false);
  assert.equal(evaluateTestRequest(url(TEST), withKey(key(TEST)), { TRACKPR_INTEGRATION_TARGET: "TEST " }).allowed, false);
  assert.equal(evaluateTestRequest(url(TEST), withKey(key(TEST)), { TRACKPR_INTEGRATION_TARGET: "prod" }).allowed, false);
  assert.equal(evaluateTestRequest("https://db.example.com/rest/v1/x", { apikey: "x" }, { NEXT_PUBLIC_SUPABASE_URL: "not a url" }).allowed, false, "an apikey request to a non-loopback host with a malformed configured URL");
});

test("real-message providers and live Stripe keys are refused; ordinary non-database requests pass", () => {
  assert.equal(evaluateTestRequest("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json", {}, {}).allowed, false);
  assert.equal(evaluateTestRequest("https://api.resend.com/emails", {}, {}).allowed, false);
  assert.equal(evaluateTestRequest("https://api.stripe.com/v1/charges", { Authorization: "Bearer sk_live_x" }, {}).allowed, false);
  assert.equal(evaluateTestRequest("https://api.stripe.com/v1/charges", { Authorization: "Bearer sk_test_x" }, {}).allowed, true);
  assert.equal(evaluateTestRequest("http://127.0.0.1:3000/api/health", {}, {}).allowed, true, "a local test server without database credentials");
});

test("request shapes cannot slip past: Request objects, URL objects, Headers instances, header arrays, mixed-case hosts, .supabase.in", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    installTestDatabaseGuard({ TRACKPR_INTEGRATION_TARGET: "test" });
    const prodKey = key(PROD);
    const attempts: (() => Promise<unknown>)[] = [
      () => fetch(new Request(url(PROD), { headers: { apikey: prodKey } })),
      () => fetch(new URL(url(PROD)), { headers: new Headers({ apikey: prodKey }) }),
      () => fetch(url(PROD).replace(PROD, PROD.toUpperCase()), { headers: [["apikey", prodKey]] }),
      () => fetch(`https://${PROD}.supabase.in/rest/v1/leads`, { headers: { APIKEY: prodKey } }),
      () => fetch(url(UNKNOWN), { headers: { apikey: key(UNKNOWN) } }),
      () => fetch(new Request(url(TEST), { headers: { apikey: key(UNKNOWN) } })),
    ];
    for (const attempt of attempts) await assert.rejects(attempt(), (error: Error) => error.name === "TestDatabaseGuardError");
    assert.equal(networkCalls, 0, "none of them reached the network");
  } finally {
    globalThis.fetch = original;
  }
});

test("child processes started with the shared loader are guarded too", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = `const r = await fetch("https://${PROD}.supabase.co/rest/v1/leads", { headers: { apikey: "x" } }).then(() => "sent", (e) => e.name); console.log(r);`;
  const out = execFileSync(process.execPath, ["--import", "./lib/automation/test-loader.mjs", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, TRACKPR_INTEGRATION_TARGET: "test" } }).trim();
  assert.equal(out, "TestDatabaseGuardError");
});
