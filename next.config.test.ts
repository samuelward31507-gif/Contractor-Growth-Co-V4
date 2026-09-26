/**
 * Trackpr 2.0, Phase 0: unit tests for next.config.ts's own redirects()
 * function - the exact configuration object Next.js's router consumes at
 * runtime for every legacy-route migration in this pass. This codebase has
 * no existing precedent for booting a live HTTP server inside a `node
 * --test` file (every integration test here calls a lib/*.ts function
 * directly against a real Supabase test org, never the Next.js server
 * itself) - the idiomatic equivalent for a routing-config change is
 * testing the literal object Next's own matcher executes, which is what
 * this file does. The actual runtime behavior (redirect chains, status
 * codes, no loops) was additionally verified live against a real built
 * server this same pass - see the Phase 0 report's own "Browser/runtime
 * QA" section for those exact results; this file is the permanent,
 * automated regression guard for the same configuration.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test next.config.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const config: typeof import("./next.config") = require("./next.config.ts");

async function getRedirects() {
  const redirectsFn = config.default.redirects;
  assert.ok(redirectsFn, "next.config.ts must export a redirects() function");
  return redirectsFn!();
}

function findRule(rules: Awaited<ReturnType<NonNullable<typeof config.default.redirects>>>, source: string, extra?: (r: (typeof rules)[number]) => boolean) {
  return rules.find((r) => r.source === source && (!extra || extra(r)));
}

test("1. /leads/[id] redirects to /customers/[id] with a lead marker, preserving the id segment exactly", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/leads/:id");
  assert.ok(rule);
  assert.equal(rule!.destination, "/customers/:id?from=lead");
  assert.equal(rule!.permanent, true);
});

test("2. /leads redirects to /customers with a lead marker", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/leads");
  assert.ok(rule);
  assert.equal(rule!.destination, "/customers?from=lead");
  assert.equal(rule!.permanent, true);
});

test("3. /contacts/[id] redirects to /customers/[id] with a contact marker, preserving the id segment exactly", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/contacts/:id");
  assert.ok(rule);
  assert.equal(rule!.destination, "/customers/:id?from=contact");
  assert.equal(rule!.permanent, true);
});

test("4. /contacts redirects to /customers with a contact marker", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/contacts");
  assert.ok(rule);
  assert.equal(rule!.destination, "/customers?from=contact");
  assert.equal(rule!.permanent, true);
});

test("5. /calendar redirects to /schedule with no forced query - view/date pass through automatically", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/calendar");
  assert.ok(rule);
  assert.equal(rule!.destination, "/schedule");
  assert.equal(rule!.permanent, true);
});

test("6a. /appointments WITH a view param renames it to apptView and forces view=list", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/appointments", (r) => Array.isArray(r.has));
  assert.ok(rule, "expected a rule matching /appointments with a `has` condition on the view query param");
  assert.equal(rule!.destination, "/schedule?view=list&apptView=:apptView");
  assert.equal(rule!.permanent, true);
  assert.deepEqual(rule!.has, [{ type: "query", key: "view", value: "(?<apptView>.*)" }]);
});

test("6b. /appointments with NO view param redirects straight to /schedule?view=list", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/appointments", (r) => Array.isArray(r.missing));
  assert.ok(rule, "expected a rule matching /appointments with a `missing` condition on the view query param");
  assert.equal(rule!.destination, "/schedule?view=list");
  assert.equal(rule!.permanent, true);
  assert.deepEqual(rule!.missing, [{ type: "query", key: "view" }]);
});

test("7. /estimates redirects to /work?type=estimates", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/estimates");
  assert.ok(rule);
  assert.equal(rule!.destination, "/work?type=estimates");
  assert.equal(rule!.permanent, true);
});

test("8. /jobs redirects to /work?type=jobs", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/jobs");
  assert.ok(rule);
  assert.equal(rule!.destination, "/work?type=jobs");
  assert.equal(rule!.permanent, true);
});

test("9. every redirect rule is marked permanent (308), never temporary", async () => {
  const rules = await getRedirects();
  for (const rule of rules) {
    assert.equal(rule.permanent, true, `rule for ${rule.source} must be permanent`);
  }
});

test("10. no rule redirects a path to itself or to another rule's own source (no direct redirect loop in the configuration)", async () => {
  const rules = await getRedirects();
  const sources = new Set(rules.map((r) => r.source));
  for (const rule of rules) {
    const destinationPath = rule.destination.split("?")[0];
    assert.ok(destinationPath !== rule.source, `rule for ${rule.source} must not redirect to itself`);
    // None of the new Trackpr 2.0 destination paths (/customers, /schedule,
    // /work) are themselves a `source` of any rule - proves the chain
    // terminates in exactly one hop at the routing-config level (the live
    // server verification separately proved the full runtime chain,
    // including the app's own unrelated auth redirect, terminates in
    // exactly 2 hops with no loop).
    assert.ok(!sources.has(destinationPath), `destination ${destinationPath} (from ${rule.source}) must never itself be a redirect source`);
  }
});

test("11. /estimates/[id], /jobs/[id], and /appointments/[id] have no redirect rule at all - explicitly out of Phase 0 scope, left fully reachable at their existing URLs", async () => {
  const rules = await getRedirects();
  assert.equal(findRule(rules, "/estimates/:id"), undefined);
  assert.equal(findRule(rules, "/jobs/:id"), undefined);
  assert.equal(findRule(rules, "/appointments/:id"), undefined);
});

test("12. exactly 9 redirect rules exist - no unrelated/unexpected rule was introduced", async () => {
  const rules = await getRedirects();
  assert.equal(rules.length, 9);
});
