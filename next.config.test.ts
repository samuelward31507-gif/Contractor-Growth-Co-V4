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
 * Nav-restructure pass: rewritten to match the actual current redirects()
 * body, which had drifted from this file across two later IA-consolidation
 * passes without being caught - this file lives at the repo root, outside
 * the app/lib tree every other `*.test.ts` file in this codebase lives
 * under, so it was silently excluded from this project's own test-runner
 * invocations (`find lib app -name "*.test.ts"`) rather than actually
 * failing anywhere visible. Fixed in the same pass that also genuinely
 * changed this file's /estimates and /jobs rules, rather than left broken.
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

test("2. /leads redirects to /people, filtered to hot leads - permanent:false since its own destination changed during IA consolidation (a stale cached 308 must not strand a returning visitor on an older destination)", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/leads");
  assert.ok(rule);
  assert.equal(rule!.destination, "/people?temperature=hot");
  assert.equal(rule!.permanent, false);
});

test("3. /contacts/[id] redirects to /customers/[id] with a contact marker, preserving the id segment exactly", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/contacts/:id((?!duplicates$)[^/]+)");
  assert.ok(rule);
  assert.equal(rule!.destination, "/customers/:id?from=contact");
  assert.equal(rule!.permanent, true);
});

test("3b. (Phase 3) /contacts/duplicates is NOT redirected - it is People's 'Review duplicates' page; every other /contacts/<id> still is", async () => {
  const { pathToRegexp } = require("next/dist/compiled/path-to-regexp") as { pathToRegexp: (path: string, keys: unknown[]) => RegExp };
  const rules = await getRedirects();
  const matching = (pathname: string) => rules.filter((r) => pathToRegexp(r.source, []).test(pathname)).map((r) => r.source);
  assert.deepEqual(matching("/contacts/duplicates"), [], "the duplicates page renders");
  assert.deepEqual(matching("/contacts/7a96ed96-2a2d-4c0c-96fb-6c692b027e8e"), ["/contacts/:id((?!duplicates$)[^/]+)"]);
});

test("4. /contacts redirects to /people - permanent:false for the same reason as /leads above", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/contacts");
  assert.ok(rule);
  assert.equal(rule!.destination, "/people");
  assert.equal(rule!.permanent, false);
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

test("7. /estimates has no redirect rule at all - nav-restructure pass made it a real, independent nav destination again, rendered directly by its own page.tsx", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/estimates");
  assert.equal(rule, undefined, "/estimates must not redirect anywhere");
});

test("8. /jobs has no redirect rule at all - same reasoning as /estimates above", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/jobs");
  assert.equal(rule, undefined, "/jobs must not redirect anywhere");
});

test("9. /money has no redirect rule - it is un-linked from navigation, not retired; the page itself stays fully reachable by URL, so it needs no redirect", async () => {
  const rules = await getRedirects();
  const rule = findRule(rules, "/money");
  assert.equal(rule, undefined, "/money must not redirect anywhere - it is a real, unmodified page, just no longer linked from nav");
});

test("10. every redirect rule whose destination is UNCHANGED since it was first introduced is permanent (308); every rule whose destination has since changed is temporary (307) - see this file's own header comment on why a stale cached 308 is unsafe across an IA change", () => {
  const permanentSources = new Set(["/leads/:id", "/contacts/:id((?!duplicates$)[^/]+)", "/calendar", "/appointments"]);
  const temporarySources = new Set(["/leads", "/contacts"]);
  return getRedirects().then((rules) => {
    for (const rule of rules) {
      if (permanentSources.has(rule.source)) {
        assert.equal(rule.permanent, true, `rule for ${rule.source} must be permanent (308) - its destination has never changed`);
      } else if (temporarySources.has(rule.source)) {
        assert.equal(rule.permanent, false, `rule for ${rule.source} must be temporary (307) - its destination changed during IA consolidation`);
      }
    }
  });
});
