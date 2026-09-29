/**
 * Phase 2A-1: getOrganizationHealth is memoized per request (React.cache).
 *
 * React.cache only memoizes inside a React server request, and only in
 * React's server build, so the proof runs lib/automation-health/
 * health-cache.scenario.mjs in a child process where health.ts's `react`
 * import resolves to React's server build (the real cache() implementation,
 * a simulated request scope, a call-counting fake Supabase client).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/health.cache.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

type ScenarioResult = {
  sameRequest: { calls: number; rpc: number; sharedResult: boolean };
  otherOrganization: { extraCalls: number; notShared: boolean };
  nextRequest: { extraCalls: number; notShared: boolean };
  otherClient: { callsA: number; callsB: number; notShared: boolean };
  outsideRequest: { firstCalls: number; secondCallsAgain: number };
};

let cached: ScenarioResult | null = null;
function scenario(): ScenarioResult {
  if (cached) return cached;
  const stdout = execFileSync(process.execPath, ["--import", "./lib/automation/test-loader.mjs", "lib/automation-health/health-cache.scenario.mjs"], { cwd: ROOT, encoding: "utf8" });
  cached = JSON.parse(stdout.trim().split("\n").pop()!) as ScenarioResult;
  return cached;
}

test("three callers in one request (top bar, briefing, end-of-day) share one health computation - the liveness RPC runs once, not three times", () => {
  const { sameRequest, outsideRequest } = scenario();
  assert.equal(sameRequest.sharedResult, true, "all three get the very same result");
  assert.equal(sameRequest.rpc, 1, "get_scheduled_automation_liveness once");
  assert.equal(sameRequest.calls, outsideRequest.firstCalls, "exactly one computation's worth of Supabase calls");
});

test("organization isolation: a different organization in the same request is computed separately", () => {
  const { otherOrganization, outsideRequest } = scenario();
  assert.equal(otherOrganization.notShared, true);
  assert.equal(otherOrganization.extraCalls, outsideRequest.firstCalls);
});

test("request scope only: the next request computes again - nothing is cached across requests", () => {
  const { nextRequest, outsideRequest } = scenario();
  assert.equal(nextRequest.notShared, true);
  assert.equal(nextRequest.extraCalls, outsideRequest.firstCalls);
});

test("a different Supabase client (e.g. service role vs session) never shares a result, even for the same organization", () => {
  const { otherClient } = scenario();
  assert.equal(otherClient.notShared, true);
  assert.ok(otherClient.callsA > 0 && otherClient.callsA === otherClient.callsB);
});

test("outside a React server request (route handlers, scripts, tests) it simply calls through", () => {
  const { outsideRequest } = scenario();
  assert.ok(outsideRequest.firstCalls > 0);
  assert.equal(outsideRequest.secondCallsAgain, outsideRequest.firstCalls);
});

test("structural: the health computation itself is unchanged and only wrapped; its Dashboard callers all go through the memoized export", () => {
  const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
  const health = read("lib/automation-health/health.ts");
  assert.match(health, /^import \{ cache \} from "react";/);
  assert.match(health, /export const getOrganizationHealth = cache\(computeOrganizationHealth\);/);
  assert.doesNotMatch(health, /unstable_cache|"use cache"|new Map\(/, "request-scoped only");
  assert.match(read("app/(app)/_components/top-bar.tsx"), /getOrganizationHealth\(supabase, organizationId\)/);
  assert.equal((read("lib/briefing/queries.ts").match(/getOrganizationHealth\(supabase, organizationId\)/g) ?? []).length, 4, "daily briefing + end-of-day summary, legacy and Phase 2D SQL sources");
});
