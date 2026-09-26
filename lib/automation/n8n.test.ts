/**
 * Trackpr 2.0, n8n dispatch timeout fix: proves triggerN8nWorkflow's real
 * timing behavior end-to-end - a legitimately slower-than-the-old-10s
 * response is no longer mistaken for a hung orchestrator, while a genuinely
 * unreachable one still fails, and still within a bounded time (never
 * infinite). No real network call is made: global fetch is temporarily
 * replaced with a fake that honors the real AbortSignal triggerN8nWorkflow
 * passes it, exactly like a real fetch() would on a slow/hung connection -
 * the module itself is untouched and exercised exactly as production code
 * calls it.
 *
 * These tests genuinely wait out real wall-clock time (this is what proves
 * the actual timeout constant's behavior, not a stand-in) - Test 3 alone
 * takes just over N8N_TIMEOUT_MS. Run in isolation if iterating:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/n8n.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { triggerN8nWorkflow, N8N_TIMEOUT_MS }: typeof import("./n8n") = require("./n8n.ts");

const REAL_FETCH = globalThis.fetch;
const REAL_BASE_URL = process.env.N8N_BASE_URL;
const REAL_SECRET = process.env.N8N_WEBHOOK_SECRET;

function withConfiguredEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.N8N_BASE_URL = "https://fake-n8n.example.test";
  process.env.N8N_WEBHOOK_SECRET = "test-secret";
  return fn().finally(() => {
    if (REAL_BASE_URL === undefined) delete process.env.N8N_BASE_URL;
    else process.env.N8N_BASE_URL = REAL_BASE_URL;
    if (REAL_SECRET === undefined) delete process.env.N8N_WEBHOOK_SECRET;
    else process.env.N8N_WEBHOOK_SECRET = REAL_SECRET;
  });
}

/** Mimics a real fetch() that takes `delayMs` to respond, honoring the AbortSignal triggerN8nWorkflow passes exactly the way the real Fetch API does - rejecting with an AbortError if the signal fires before the delay elapses. */
function delayedFetch(delayMs: number, status = 200): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ ok: true }), { status })), delayMs);
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }
    })) as typeof fetch;
}

const contract = {
  version: 1 as const,
  event: { id: "evt-1", type: "lead.created", organization_id: "org-1", entity_type: "lead", entity_id: "lead-1", payload: {} },
  execution: { id: "exec-1", workflow_name: "lead_created_followup", attempt: 1 },
  context: { organization: { id: "org-1", name: "Test Org", timezone: "UTC" }, ai: { enabled: true, tone: null, business_introduction: null, general_instructions: null }, contact: null },
};

test("1. a fast, successful n8n response records a successful dispatch", async () => {
  await withConfiguredEnv(async () => {
    globalThis.fetch = delayedFetch(50);
    try {
      const result = await triggerN8nWorkflow(contract);
      assert.equal(result.ok, true);
    } finally {
      globalThis.fetch = REAL_FETCH;
    }
  });
});

test("2. a response slower than the OLD 10s threshold, but within the real timeout, is never mistaken for a failure", async () => {
  await withConfiguredEnv(async () => {
    assert.ok(N8N_TIMEOUT_MS > 15_000, "this test assumes the real production timeout is generous enough to safely exceed the old 10s value - update the 15s delay below if N8N_TIMEOUT_MS ever changes");
    globalThis.fetch = delayedFetch(15_000);
    try {
      const result = await triggerN8nWorkflow(contract);
      assert.equal(result.ok, true, "a real 15s round trip - well past the old 10s constant - must succeed under the real production timeout");
    } finally {
      globalThis.fetch = REAL_FETCH;
    }
  });
});

test("3. an orchestrator that never responds still fails, and still within a bounded time - the timeout is not disabled or infinite", async () => {
  await withConfiguredEnv(async () => {
    globalThis.fetch = delayedFetch(N8N_TIMEOUT_MS + 5_000);
    const startedAt = Date.now();
    try {
      const result = await triggerN8nWorkflow(contract);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "Could not reach the automation orchestrator.");
      assert.ok(elapsedMs < N8N_TIMEOUT_MS + 4_000, `expected the abort to fire at ~${N8N_TIMEOUT_MS}ms, not wait for the full ${N8N_TIMEOUT_MS + 5_000}ms delay (actual: ${elapsedMs}ms)`);
    } finally {
      globalThis.fetch = REAL_FETCH;
    }
  });
});
