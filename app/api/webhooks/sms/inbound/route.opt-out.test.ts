/**
 * Phase 3F: the inbound SMS webhook's STOP/START write hardening, end to end
 * through the real route handler. Every module the route imports that could
 * touch the network or a database is mocked (the Supabase service client is
 * a scripted in-memory fake), so nothing reaches TEST, Production or Twilio
 * and no local environment file is loaded. The real keyword matcher and the real
 * writeSmsOptOut helper run.
 *
 * Proves: a persisted STOP/START continues exactly as before; a write that
 * fails twice returns 500 BEFORE the message is inserted and before any
 * conversation, cost, classifier or automation step; the already-opted-out
 * / already-opted-in guards skip the write; the failure log carries only
 * safe fields.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/api/webhooks/sms/inbound/route.opt-out.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

const BODY_MARKER = "+15555550123";
const FROM = "+15555550123";
const TO = "+15555550999";
const MESSAGE_SID = "SM0123456789abcdef0123456789abcdef";

type UpdateOutcome = { data: { id: string }[] | null; error: { code: string; message: string; details?: string; hint?: string } | null };

const state = {
  contactOptOut: false,
  updateOutcomes: [] as UpdateOutcome[],
  updates: [] as unknown[],
  messageInserts: [] as unknown[],
  calls: [] as string[],
};

const record = (name: string, result: unknown) => async () => {
  state.calls.push(name);
  return result;
};

function fakeService() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => ((filters[column] = value), builder),
        maybeSingle: async () => {
          if (table === "messages") return { data: null, error: null };
          if (table === "organizations") return { data: { id: "org-1", name: "Acme Roofing", phone: null, email: null }, error: null };
          if (table === "contacts") return { data: { id: "contact-1", sms_opt_out: state.contactOptOut }, error: null };
          if (table === "conversations") return { data: { lead_id: null }, error: null };
          return { data: null, error: null };
        },
        update: (update: unknown) => ({
          eq: () => ({
            select: async () => {
              state.calls.push(`update ${table}`);
              state.updates.push(update);
              return state.updateOutcomes.shift() ?? { data: [{ id: "contact-1" }], error: null };
            },
          }),
        }),
        insert: (row: unknown) => {
          state.calls.push(`insert ${table}`);
          if (table === "messages") state.messageInserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "message-1" }, error: null }) }) };
        },
      };
      return builder;
    },
  };
}

mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => fakeService() } });
mock.module(lib("lib/messaging/twilio-signature.ts"), { namedExports: { isValidTwilioSignature: () => true } });
mock.module(lib("lib/contacts/resolve.ts"), { namedExports: { resolveOrCreateContact: async () => ({ outcome: "matched", contact: { id: "contact-1" } }) } });
mock.module(lib("lib/conversations/queries.ts"), { namedExports: { findOrCreateOpenConversation: record("findOrCreateOpenConversation", { id: "conversation-1" }) } });
mock.module(lib("lib/costs/sms-cost-events.ts"), { namedExports: { recordSmsCostEventForMessage: record("recordSmsCostEventForMessage", { outcome: "recorded" }) } });
mock.module(lib("lib/automation/customer-reply.ts"), { namedExports: { emitCustomerReplyFollowup: record("emitCustomerReplyFollowup", undefined) } });
mock.module(lib("lib/messaging/outbound.ts"), { namedExports: { sendOutboundMessage: record("sendOutboundMessage", { ok: true }) } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), {
  namedExports: { recordRequestResponses: record("recordRequestResponses", undefined), classifyAndEscalateReviewReply: record("classifyAndEscalateReviewReply", undefined) },
});
mock.module(lib("lib/automation/estimate-reply.ts"), { namedExports: { classifyAndProcessEstimateReply: record("classifyAndProcessEstimateReply", undefined) } });
mock.module(lib("lib/automation/booking-reply.ts"), { namedExports: { classifyAndProcessBookingReply: record("classifyAndProcessBookingReply", false), handleBareCancelAppointmentReply: record("handleBareCancelAppointmentReply", false) } });

const { POST } = await import(lib("app/api/webhooks/sms/inbound/route.ts"));
const { NextRequest } = await import("next/server");

const DB_ERROR: UpdateOutcome = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout", details: `Key (phone)=(${BODY_MARKER})`, hint: "hint-marker" } };

function inbound(body: string) {
  const form = new URLSearchParams({ MessageSid: MESSAGE_SID, From: FROM, To: TO, Body: body });
  return new NextRequest("https://example.test/api/webhooks/sms/inbound", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "test-signature" },
    body: form.toString(),
  });
}

async function run(body: string) {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const response = await POST(inbound(body));
    return { response, logged };
  } finally {
    console.error = original;
  }
}

const DOWNSTREAM = [
  "findOrCreateOpenConversation",
  "insert messages",
  "recordSmsCostEventForMessage",
  "classifyAndEscalateReviewReply",
  "classifyAndProcessEstimateReply",
  "classifyAndProcessBookingReply",
  "emitCustomerReplyFollowup",
  "recordRequestResponses",
  "sendOutboundMessage",
];

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = "test-token-not-a-secret";
  state.contactOptOut = false;
  state.updateOutcomes = [];
  state.updates = [];
  state.messageInserts = [];
  state.calls = [];
});

test("STOP persisted on the first attempt: 200, message recorded, no AI/classifier/automation (unchanged behavior)", async () => {
  const { response } = await run("STOP");
  assert.equal(response.status, 200);
  assert.deepEqual(state.updates, [{ sms_opt_out: true }]);
  assert.deepEqual(state.calls, ["update contacts", "findOrCreateOpenConversation", "insert messages", "recordSmsCostEventForMessage"]);
});

test("STOP fails once, the retry succeeds: 200 and the flow continues exactly as before", async () => {
  state.updateOutcomes = [DB_ERROR];
  const { response } = await run("stop");
  assert.equal(response.status, 200);
  assert.deepEqual(state.updates, [{ sms_opt_out: true }, { sms_opt_out: true }]);
  assert.equal(state.messageInserts.length, 1);
});

test("STOP fails twice: 500 before the message is inserted, and nothing downstream runs", async () => {
  state.updateOutcomes = [DB_ERROR, DB_ERROR];
  const { response, logged } = await run("STOP");
  assert.equal(response.status, 500);
  assert.equal(state.updates.length, 2, "exactly one retry");
  assert.equal(state.messageInserts.length, 0);
  for (const step of DOWNSTREAM) assert.ok(!state.calls.includes(step), `${step} must not run`);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "[sms][inbound] failed to persist sms_opt_out");
  assert.deepEqual(logged[0][1], {
    organizationId: "org-1",
    contactId: "contact-1",
    keyword: "stop",
    attempts: 2,
    finalFailure: true,
    errorCode: "57014",
    errorMessage: "canceling statement due to statement timeout",
  });
});

test("STOP: zero updated rows on both attempts counts as a failed write - 500, no message", async () => {
  state.updateOutcomes = [
    { data: [], error: null },
    { data: [], error: null },
  ];
  const { response } = await run("UNSUBSCRIBE");
  assert.equal(response.status, 500);
  assert.equal(state.messageInserts.length, 0);
});

test("STOP from an already-opted-out contact: no write (existing guard), 200, message recorded", async () => {
  state.contactOptOut = true;
  const { response } = await run("STOP");
  assert.equal(response.status, 200);
  assert.deepEqual(state.updates, []);
  assert.equal(state.messageInserts.length, 1);
});

test("START persisted for an opted-out contact: writes sms_opt_out = false, 200, message recorded", async () => {
  state.contactOptOut = true;
  const { response } = await run("START");
  assert.equal(response.status, 200);
  assert.deepEqual(state.updates, [{ sms_opt_out: false }]);
  assert.deepEqual(state.calls, ["update contacts", "findOrCreateOpenConversation", "insert messages", "recordSmsCostEventForMessage"]);
});

test("START fails once, the retry succeeds: 200 and the flow continues", async () => {
  state.contactOptOut = true;
  state.updateOutcomes = [DB_ERROR];
  const { response } = await run("start");
  assert.equal(response.status, 200);
  assert.equal(state.updates.length, 2);
  assert.equal(state.messageInserts.length, 1);
});

test("START fails twice: 500 before the message is inserted; the contact stays opted out (no successful write)", async () => {
  state.contactOptOut = true;
  state.updateOutcomes = [DB_ERROR, DB_ERROR];
  const { response, logged } = await run("START");
  assert.equal(response.status, 500);
  assert.equal(state.updates.length, 2);
  assert.equal(state.messageInserts.length, 0);
  for (const step of DOWNSTREAM) assert.ok(!state.calls.includes(step), `${step} must not run`);
  assert.equal((logged[0][1] as { keyword: string }).keyword, "start");
});

test("START from a contact who is not opted out: no write (existing guard), 200", async () => {
  const { response } = await run("START");
  assert.equal(response.status, 200);
  assert.deepEqual(state.updates, []);
});

test("the failure log never contains the message body, phone numbers, the Twilio SID or the database error's details/hint", async () => {
  state.updateOutcomes = [DB_ERROR, DB_ERROR];
  const { logged } = await run("STOP");
  const text = JSON.stringify(logged);
  for (const secret of [FROM, TO, MESSAGE_SID, BODY_MARKER, "hint-marker", "Key (phone)", "details", "hint", "STOP"]) {
    assert.ok(!text.includes(secret), `log must not contain ${secret}`);
  }
  assert.deepEqual(Object.keys(logged[0][1] as object).sort(), ["attempts", "contactId", "errorCode", "errorMessage", "finalFailure", "keyword", "organizationId"]);
});

test("a non-keyword message never touches sms_opt_out (unchanged path)", async () => {
  const { response } = await run("Can you come Tuesday?");
  assert.equal(response.status, 200);
  assert.deepEqual(state.updates, []);
  assert.ok(state.calls.includes("emitCustomerReplyFollowup"));
});
