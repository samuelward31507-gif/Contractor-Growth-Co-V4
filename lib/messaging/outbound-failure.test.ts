/**
 * sendOutboundMessage's provider-failure result: a send the provider never
 * attempted because this environment has no SMS credentials reports
 * providerUnconfigured, and a provider rejection carries the provider's error
 * code - so callers can log an actionable cause. The failed row is still
 * recorded with its reason; the message text, phone and provider wording are
 * never part of the result's diagnostic fields.
 *
 * Offline: an in-memory fake session client, a fake SMS sender and a mocked
 * service-role client. No network, no database, no provider.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/messaging/outbound-failure.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
let messages: Row[] = [];
let optedOut = false;
const outcomes: Row[] = [];

// recordProviderOutcome's own service-role client: capture the update it records.
mock.module(lib("lib/supabase/service.ts"), {
  namedExports: {
    createServiceRoleClient: () => ({
      from: () => {
        let values: Row = {};
        const b: Record<string, unknown> = {};
        b.update = (v: Row) => ((values = v), b);
        b.eq = () => b;
        b.select = async () => (outcomes.push(values), { data: [{ id: "msg-1" }], error: null });
        return b;
      },
    }),
  },
});
mock.module(lib("lib/messaging/opt-out.ts"), { namedExports: { writeSmsOptOut: async () => ({ ok: true }) } });

const { sendOutboundMessage } = await import(lib("lib/messaging/outbound.ts"));

const PHONE = "+15555550123";
const BODY = "Acme Roofing: Invoice INV-000008 for $450 is ready. View it here: https://app.example.test/pay/abc Reply STOP to opt out.";

function session(): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const name of ["select", "eq"]) b[name] = () => b;
      b.maybeSingle = async () => ({ data: table === "contacts" ? { phone: PHONE, phone_normalized: PHONE, sms_opt_out: optedOut } : null, error: null });
      b.insert = (row: Row) => ({
        select: () => ({
          single: async () => {
            messages.push(row);
            return { data: { id: "msg-1" }, error: null };
          },
        }),
      });
      return b;
    },
  } as unknown as SupabaseClient;
}

const input = (sendSmsFn: unknown) => ({ organizationId: "org-1", contactId: "contact-1", conversationId: "conv-1", channel: "sms", senderType: "user", body: BODY, sendSmsFn });

beforeEach(() => {
  messages = [];
  outcomes.length = 0;
  optedOut = false;
});

const PREVIEW = { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
const PRODUCTION = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
const TWILIO = { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM_NUMBER: "+15555550100" };

function providerSpy() {
  const calls: unknown[] = [];
  return { calls, fn: async (call: unknown) => (calls.push(call), { ok: true as const, providerMessageId: "SM_should_not_happen" }) };
}

test("simulated (Preview, no SMS provider): the message is recorded as SIMULATED - status logged, sim_ id, explicit reason - and the provider is never called", async () => {
  const spy = providerSpy();
  const result = await sendOutboundMessage(session(), { ...input(spy.fn), simulate: true, simulationEnv: PREVIEW });
  assert.equal(spy.calls.length, 0, "no provider call");
  assert.equal(result.ok, true);
  assert.equal((result as { simulated?: true }).simulated, true);
  assert.match((result as { providerMessageId: string }).providerMessageId, /^sim_[0-9a-f-]{36}$/);
  assert.equal(messages.length, 1);
  const row = messages[0];
  assert.equal(row.status, "logged", "never 'sent' or 'delivered'");
  assert.equal(row.direction, "outbound");
  assert.equal(row.organization_id, "org-1");
  assert.equal(row.provider_message_id, (result as { providerMessageId: string }).providerMessageId);
  assert.match(String(row.status_reason), /^SIMULATED: no SMS was sent and no phone was contacted/);
  assert.equal(row.body, BODY, "the exact message that would have been sent stays auditable");
  assert.deepEqual(outcomes, [], "no provider outcome is recorded - nothing was sent");
});

test("simulation is refused in Production and wherever a real SMS provider is configured: no row, no provider call", async () => {
  for (const [name, environment] of [
    ["Vercel Production", PRODUCTION],
    ["self-hosted production build", { NODE_ENV: "production" }],
    ["Preview with a configured provider", { ...PREVIEW, ...TWILIO }],
  ] as [string, NodeJS.ProcessEnv][]) {
    messages = [];
    const spy = providerSpy();
    const result = await sendOutboundMessage(session(), { ...input(spy.fn), simulate: true, simulationEnv: environment });
    assert.deepEqual(result, { ok: false, error: "Simulated delivery isn't available in this environment.", messageId: null, conversationId: "conv-1" }, name);
    assert.deepEqual([messages.length, spy.calls.length], [0, 0], name);
  }
});

test("opt-out still wins over simulation: an opted-out contact is recorded as blocked, never as simulated", async () => {
  optedOut = true;
  const spy = providerSpy();
  const result = await sendOutboundMessage(session(), { ...input(spy.fn), simulate: true, simulationEnv: PREVIEW });
  assert.equal(result.ok, false);
  assert.equal(spy.calls.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, "failed");
  assert.equal(messages[0].provider_message_id, undefined);
});

test("a normal send never falls back to simulation: without a provider it still fails as unconfigured", async () => {
  const result = await sendOutboundMessage(session(), input(async () => ({ ok: false, error: "SMS delivery is not configured for this environment.", unconfigured: true })));
  assert.equal(result.ok, false);
  assert.equal((result as { providerUnconfigured?: true }).providerUnconfigured, true);
  assert.equal(messages[0].status, "queued", "inserted as a real send attempt, then marked failed");
  assert.deepEqual(outcomes, [{ status: "failed", status_reason: "SMS delivery is not configured for this environment." }]);
});

test("no SMS credentials in this environment: the failure is flagged providerUnconfigured, with no provider code, and the row records the reason", async () => {
  const result = await sendOutboundMessage(session(), input(async () => ({ ok: false, error: "SMS delivery is not configured for this environment.", unconfigured: true })));
  assert.deepEqual(result, { ok: false, error: "SMS delivery is not configured for this environment.", messageId: "msg-1", conversationId: "conv-1", providerUnconfigured: true });
  assert.deepEqual(outcomes, [{ status: "failed", status_reason: "SMS delivery is not configured for this environment." }]);
});

test("provider rejection: the provider's error code is returned (and recorded) - never its message text", async () => {
  const result = await sendOutboundMessage(session(), input(async () => ({ ok: false, error: "The SMS provider rejected the request.", providerErrorCode: "21608" })));
  assert.deepEqual(result, { ok: false, error: "The SMS provider rejected the request.", messageId: "msg-1", conversationId: "conv-1", providerErrorCode: "21608" });
  assert.deepEqual(outcomes, [{ status: "failed", status_reason: "The SMS provider rejected the request.", provider_error_code: "21608" }]);
});

test("a plain failure (e.g. invalid destination) carries neither diagnostic flag; a success is unchanged", async () => {
  const failed = await sendOutboundMessage(session(), input(async () => ({ ok: false, error: "The destination phone number is not a valid E.164 number." })));
  assert.equal("providerUnconfigured" in failed, false);
  assert.equal("providerErrorCode" in failed, false);
  outcomes.length = 0;
  const sent = await sendOutboundMessage(session(), input(async () => ({ ok: true, providerMessageId: "SM1" })));
  assert.deepEqual(sent, { ok: true, messageId: "msg-1", conversationId: "conv-1", providerMessageId: "SM1" });
  assert.deepEqual(outcomes, [{ status: "sent", provider_message_id: "SM1" }]);
});
