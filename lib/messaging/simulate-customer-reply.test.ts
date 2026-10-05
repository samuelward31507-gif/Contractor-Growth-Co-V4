/**
 * TEST-only "Simulate Customer Reply": the environment guard, input
 * validation, and the core simulateInboundCustomerReply path, run through
 * the REAL lib/messaging/inbound-customer-message.ts (shared with the Twilio
 * webhook). Every module that could reach a network or send anything is
 * mocked, and the send/cost modules are asserted never to be called, so
 * nothing reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/messaging/simulate-customer-reply.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

const SIMULATION_ID = "3f1c9a52-7b4e-4d1a-9c2e-5a6b7c8d9e0f";

const state = {
  calls: [] as string[],
  args: {} as Record<string, unknown[]>,
  messageInserts: [] as Record<string, unknown>[],
  insertError: null as { code: string; message: string } | null,
  bookingHandled: false,
};

const record = (name: string, result: () => unknown) => async (...args: unknown[]) => {
  state.calls.push(name);
  state.args[name] = args;
  return result();
};

function fakeService() {
  return {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        state.calls.push(`insert ${table}`);
        if (table === "messages") state.messageInserts.push(row);
        return { error: state.insertError };
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            state.calls.push(`select ${table}`);
            return { data: table === "conversations" ? { lead_id: "lead-1" } : null };
          },
        }),
      }),
    }),
  };
}

mock.module(lib("lib/automation/customer-reply.ts"), { namedExports: { emitCustomerReplyFollowup: record("emitCustomerReplyFollowup", () => undefined) } });
mock.module(lib("lib/automation/estimate-reply.ts"), { namedExports: { classifyAndProcessEstimateReply: record("classifyAndProcessEstimateReply", () => undefined) } });
mock.module(lib("lib/automation/booking-reply.ts"), { namedExports: { classifyAndProcessBookingReply: record("classifyAndProcessBookingReply", () => state.bookingHandled) } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), {
  namedExports: { recordRequestResponses: record("recordRequestResponses", () => undefined), classifyAndEscalateReviewReply: record("classifyAndEscalateReviewReply", () => undefined) },
});
// Anything that could transmit or price a real message - must never run.
mock.module(lib("lib/messaging/outbound.ts"), { namedExports: { sendOutboundMessage: record("sendOutboundMessage", () => ({ ok: true })) } });
mock.module(lib("lib/automation/sms.ts"), { namedExports: { sendSms: record("sendSms", () => ({ ok: true })) } });
mock.module(lib("lib/costs/sms-cost-events.ts"), { namedExports: { recordSmsCostEventForMessage: record("recordSmsCostEventForMessage", () => ({ outcome: "recorded" })) } });

const {
  isCustomerReplySimulationEnvironment,
  validateSimulatedReply,
  simulatedProviderMessageId,
  simulateInboundCustomerReply,
  SIMULATED_REPLY_MAX_LENGTH,
} = await import(lib("lib/messaging/simulate-customer-reply.ts"));

const NEVER_CALLED = ["sendOutboundMessage", "sendSms", "recordSmsCostEventForMessage"];

beforeEach(() => {
  state.calls = [];
  state.args = {};
  state.messageInserts = [];
  state.insertError = null;
  state.bookingHandled = false;
});

const simulate = (body = "It's a single-story house with an older roof.") =>
  simulateInboundCustomerReply(fakeService(), { organizationId: "org-1", contactId: "contact-1", conversationId: "conversation-1", body, simulationId: SIMULATION_ID });

test("the environment guard allows only non-production deployments", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
  assert.equal(isCustomerReplySimulationEnvironment(env({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" })), false);
  assert.equal(isCustomerReplySimulationEnvironment(env({ NODE_ENV: "production" })), false, "a self-hosted production build is production");
  assert.equal(isCustomerReplySimulationEnvironment(env({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" })), true);
  assert.equal(isCustomerReplySimulationEnvironment(env({ VERCEL: "1", VERCEL_ENV: "development" })), true);
  assert.equal(isCustomerReplySimulationEnvironment(env({ NODE_ENV: "development" })), true);
  assert.equal(isCustomerReplySimulationEnvironment(env({ VERCEL_ENV: "something-else", NODE_ENV: "development" })), false, "an unknown Vercel environment fails closed");
});

test("validation rejects empty, oversized and malformed input, and every SMS compliance keyword", () => {
  assert.deepEqual(validateSimulatedReply("  Sounds good, thanks  ", SIMULATION_ID), { ok: true, body: "Sounds good, thanks" });
  assert.equal(validateSimulatedReply("   ", SIMULATION_ID).ok, false);
  assert.equal(validateSimulatedReply("x".repeat(SIMULATED_REPLY_MAX_LENGTH + 1), SIMULATION_ID).ok, false);
  assert.equal(validateSimulatedReply("Sounds good", "not-a-uuid").ok, false);
  for (const keyword of ["STOP", "stop", "START", "HELP", "help"]) {
    assert.equal(validateSimulatedReply(keyword, SIMULATION_ID).ok, false, `${keyword} must be refused - in the real webhook it writes opt-out state or sends an ungated HELP reply`);
  }
});

test("the simulated provider id is clearly synthetic and deterministic per submission", () => {
  const id = simulatedProviderMessageId(SIMULATION_ID);
  assert.equal(id, `sim_${SIMULATION_ID}`);
  assert.equal(id, simulatedProviderMessageId(SIMULATION_ID.toUpperCase()));
  assert.ok(!id.startsWith("SM") && !id.startsWith("MM"), "must never look like a real Twilio SID");
});

test("a simulated reply is stored like a real inbound message and runs the shared inbound path - and nothing is sent or priced", async () => {
  const result = await simulate();

  assert.deepEqual(result, { ok: true, duplicate: false });
  assert.deepEqual(state.messageInserts, [
    {
      organization_id: "org-1",
      conversation_id: "conversation-1",
      direction: "inbound",
      sender_type: "customer",
      body: "It's a single-story house with an older roof.",
      status: "received",
      provider_message_id: `sim_${SIMULATION_ID}`,
    },
  ]);
  assert.deepEqual(state.calls, [
    "insert messages",
    "select conversations",
    "classifyAndEscalateReviewReply",
    "classifyAndProcessEstimateReply",
    "classifyAndProcessBookingReply",
    "emitCustomerReplyFollowup",
    "recordRequestResponses",
  ]);
  assert.deepEqual(state.args.emitCustomerReplyFollowup?.[1], {
    organizationId: "org-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    leadId: "lead-1",
    messageBody: "It's a single-story house with an older roof.",
    providerMessageId: `sim_${SIMULATION_ID}`,
  });
  for (const name of NEVER_CALLED) assert.ok(!state.calls.includes(name), `${name} must never be called`);
});

test("a replayed submission is an idempotent no-op on the messages provider-id unique index", async () => {
  state.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };

  assert.deepEqual(await simulate(), { ok: true, duplicate: true });
  assert.deepEqual(state.calls, ["insert messages"], "no classifier, automation or bookkeeping may run a second time");
});

test("a failed insert stops before any automation", async () => {
  state.insertError = { code: "57014", message: "statement timeout" };
  const original = console.error;
  console.error = () => {};
  try {
    const result = await simulate();
    assert.equal(result.ok, false);
  } finally {
    console.error = original;
  }
  assert.deepEqual(state.calls, ["insert messages"]);
});

test("when booking-reply fully owns the turn, the AI reply automation is skipped - same as the real webhook", async () => {
  state.bookingHandled = true;

  await simulate("The second time works for me");

  assert.ok(!state.calls.includes("emitCustomerReplyFollowup"));
  assert.ok(state.calls.includes("recordRequestResponses"));
  for (const name of NEVER_CALLED) assert.ok(!state.calls.includes(name), `${name} must never be called`);
});
