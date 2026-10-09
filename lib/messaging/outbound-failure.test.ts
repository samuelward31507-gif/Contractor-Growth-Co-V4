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
      b.maybeSingle = async () => ({ data: table === "contacts" ? { phone: PHONE, phone_normalized: PHONE, sms_opt_out: false } : null, error: null });
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
