/**
 * Final Batch 4: a missing CRON_SECRET still fails closed, but is reported.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/cron-auth.batch4.test.ts
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;
const alerts: Record<string, unknown>[] = [];
mock.module(lib("lib/ops/alert.ts"), { namedExports: { reportOpsAlert: async (alert: Record<string, unknown>) => void alerts.push(alert) } });
const { isAuthorizedCronRequest } = await import(lib("lib/automation/cron-auth.ts"));

const request = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as never;

test("missing CRON_SECRET: refused (fail closed) and reported once per call, without any header value", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorizedCronRequest(request("Bearer guessed")), false);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].code, "cron_secret_missing");
    assert.ok(!JSON.stringify(alerts[0]).includes("guessed"));
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("configured CRON_SECRET: unchanged constant-time check, no alert", () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "batch4-test-only-secret";
  alerts.length = 0;
  try {
    assert.equal(isAuthorizedCronRequest(request("Bearer batch4-test-only-secret")), true);
    assert.equal(isAuthorizedCronRequest(request("Bearer wrong")), false);
    assert.equal(isAuthorizedCronRequest(request()), false);
    assert.equal(alerts.length, 0);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
