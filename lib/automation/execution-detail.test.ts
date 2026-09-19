/**
 * Unit tests for sanitizeForDisplay() and getExecutionDetail() (Phase F) -
 * against pure inputs / a mocked Supabase client, no real database, no
 * production fixtures. execution-detail.ts has no "@/"-aliased imports
 * (only relative imports to catalog.ts, which has none either), so this
 * loads cleanly via the require()-with-explicit-.ts-path pattern - see
 * lib/automation/authorization.test.ts. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/execution-detail.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { sanitizeForDisplay, getExecutionDetail }: typeof import("./execution-detail") = require("./execution-detail.ts");

test("redacts every secret/token/credential-shaped key regardless of exact name", () => {
  const result = sanitizeForDisplay({
    token: "abc123",
    api_key: "abc123",
    apiKey: "abc123",
    webhook_secret: "abc123",
    cron_secret: "abc123",
    password: "abc123",
    passwd: "abc123",
    credential_id: "abc123",
    authorization: "Bearer abc123",
    normal_field: "safe value",
  });

  assert.ok(result);
  assert.equal(result!.token, "[redacted]");
  assert.equal(result!.api_key, "[redacted]");
  assert.equal(result!.apiKey, "[redacted]");
  assert.equal(result!.webhook_secret, "[redacted]");
  assert.equal(result!.cron_secret, "[redacted]");
  assert.equal(result!.password, "[redacted]");
  assert.equal(result!.passwd, "[redacted]");
  assert.equal(result!.credential_id, "[redacted]");
  assert.equal(result!.authorization, "[redacted]");
  assert.equal(result!.normal_field, "safe value");
});

test("redacts a secret-like key even when nested inside another object", () => {
  const result = sanitizeForDisplay({ context: { nested_secret_key: "abc123", ok_field: "fine" } });

  assert.ok(result);
  const nested = result!.context as Record<string, unknown>;
  assert.equal(nested.nested_secret_key, "[redacted]");
  assert.equal(nested.ok_field, "fine");
});

test("truncates an excessively long string value", () => {
  const longValue = "x".repeat(1000);
  const result = sanitizeForDisplay({ message_body: longValue });

  assert.ok(result);
  const value = result!.message_body as string;
  assert.ok(value.length < 1000);
  assert.ok(value.endsWith("(truncated)"));
});

test("caps recursion depth rather than deeply serializing arbitrary nested structures", () => {
  const result = sanitizeForDisplay({ a: { b: { c: { d: "too deep" } } } });

  assert.ok(result);
  // Depth cap is 2 - by the third level of nesting, the value is replaced
  // with a placeholder rather than continuing to recurse indefinitely.
  const a = result!.a as Record<string, unknown>;
  const b = a.b as Record<string, unknown>;
  assert.equal(typeof b.c, "string");
});

test("returns null for anything that isn't a plain object (fails safe)", () => {
  assert.equal(sanitizeForDisplay(null), null);
  assert.equal(sanitizeForDisplay(undefined), null);
  assert.equal(sanitizeForDisplay("a string"), null);
  assert.equal(sanitizeForDisplay(["an", "array"]), null);
  assert.equal(sanitizeForDisplay(42), null);
});

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "99999999-9999-9999-9999-999999999999";
const EXECUTION_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";

function chainable(data: unknown) {
  const node = { eq: () => node, maybeSingle: async () => ({ data }) };
  return node;
}

test("getExecutionDetail returns null when the execution does not belong to the caller's organization", async () => {
  // Simulates RLS/explicit-filter behavior: a query scoped by
  // organization_id for a cross-org execution id finds nothing.
  const client = {
    from: () => ({ select: () => chainable(null) }),
  } as unknown as SupabaseClient;

  const detail = await getExecutionDetail(client, OTHER_ORG_ID, EXECUTION_ID);

  assert.equal(detail, null);
});

test("getExecutionDetail resolves the automation name from the parent event's event_type and sanitizes metadata/payload", async () => {
  const client = {
    from(table: string) {
      if (table === "workflow_executions") {
        return {
          select: () => chainable({
            id: EXECUTION_ID,
            organization_id: ORG_ID,
            automation_event_id: EVENT_ID,
            workflow_name: "lead_created_followup",
            status: "failed",
            attempt: 1,
            started_at: "2026-01-01T00:00:00Z",
            completed_at: null,
            error_message: "Could not reach the automation orchestrator.",
            metadata: { should_send: false, webhook_secret: "shh" },
            trigger_source: "event",
          }),
        };
      }
      if (table === "automation_events") {
        return {
          select: () => chainable({
            event_type: "lead.created",
            payload: { lead_id: "44444444-4444-4444-4444-444444444444", api_key: "shh" },
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  const detail = await getExecutionDetail(client, ORG_ID, EXECUTION_ID);

  assert.ok(detail);
  assert.equal(detail!.automationId, "instant-lead-followup");
  assert.equal(detail!.automationName, "Instant Lead Follow-Up");
  assert.equal(detail!.automationEventId, EVENT_ID);
  assert.equal(detail!.metadata?.webhook_secret, "[redacted]");
  assert.equal(detail!.payload?.api_key, "[redacted]");
  assert.equal(detail!.payload?.lead_id, "44444444-4444-4444-4444-444444444444");
});

test("getExecutionDetail falls back to workflow_name when there is no parent event to resolve event_type from", async () => {
  const client = {
    from(table: string) {
      if (table === "workflow_executions") {
        return {
          select: () => chainable({
            id: EXECUTION_ID,
            organization_id: ORG_ID,
            automation_event_id: null,
            workflow_name: "appointment_reminder",
            status: "completed",
            attempt: 1,
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2026-01-01T00:01:00Z",
            error_message: null,
            metadata: null,
            trigger_source: "event",
          }),
        };
      }
      throw new Error(`unexpected table: ${table} (no automation_events lookup should happen with a null automation_event_id)`);
    },
  } as unknown as SupabaseClient;

  const detail = await getExecutionDetail(client, ORG_ID, EXECUTION_ID);

  assert.ok(detail);
  assert.equal(detail!.automationId, "appointment-reminders");
  assert.equal(detail!.automationEventId, null);
});
