/**
 * The simulated-SMS guard (lib/messaging/simulated-delivery.ts): simulation is
 * allowed only on a non-production deployment with no SMS provider
 * configured - never in production, and never where a real provider exists.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/messaging/simulated-delivery.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSimulateSmsDelivery,
  isMessagingSimulationEnvironment,
  isSimulatedMessage,
  isSmsProviderConfigured,
  simulatedSmsProviderMessageId,
  SIMULATED_PROVIDER_MESSAGE_ID_PREFIX,
  SIMULATED_SMS_STATUS_REASON,
} from "./simulated-delivery";
import { isCustomerReplySimulationEnvironment, SIMULATED_PROVIDER_MESSAGE_ID_PREFIX as REPLY_PREFIX } from "./simulate-customer-reply";
import { messageTimelineLabel } from "@/lib/people/timeline";

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const TWILIO = { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM_NUMBER: "+15555550100" };

test("allowed only on a non-production deployment with no SMS provider configured", () => {
  assert.equal(canSimulateSmsDelivery(env({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" })), true, "Vercel Preview, no Twilio");
  assert.equal(canSimulateSmsDelivery(env({ VERCEL: "1", VERCEL_ENV: "development" })), true);
  assert.equal(canSimulateSmsDelivery(env({ NODE_ENV: "development" })), true, "local development");
});

test("never in production - Vercel Production or a self-hosted production build - even with no SMS provider", () => {
  assert.equal(canSimulateSmsDelivery(env({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" })), false);
  assert.equal(canSimulateSmsDelivery(env({ NODE_ENV: "production" })), false);
  assert.equal(canSimulateSmsDelivery(env({ VERCEL_ENV: "something-else", NODE_ENV: "development" })), false, "an unknown Vercel environment fails closed");
});

test("never where a real SMS provider is configured - a configured environment always sends for real", () => {
  assert.equal(canSimulateSmsDelivery(env({ VERCEL: "1", VERCEL_ENV: "preview", ...TWILIO })), false);
  assert.equal(isSmsProviderConfigured(env(TWILIO)), true);
  for (const missing of Object.keys(TWILIO)) {
    const partial = { ...TWILIO } as Record<string, string>;
    delete partial[missing];
    assert.equal(isSmsProviderConfigured(env(partial)), false, `${missing} missing = not configured (the same rule sendSms uses)`);
  }
});

test("the environment rule is the one 'Simulate customer reply' already uses, and the record markers are fixed", () => {
  for (const values of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "production" }, { NODE_ENV: "production" }, { NODE_ENV: "development" }] as Record<string, string>[]) {
    assert.equal(isMessagingSimulationEnvironment(env(values)), isCustomerReplySimulationEnvironment(env(values)), JSON.stringify(values));
  }
  assert.equal(REPLY_PREFIX, SIMULATED_PROVIDER_MESSAGE_ID_PREFIX);
  assert.equal(simulatedSmsProviderMessageId("ABC-123"), "sim_abc-123");
  assert.equal(isSimulatedMessage({ provider_message_id: "sim_abc" }), true);
  assert.equal(isSimulatedMessage({ provider_message_id: "SM123" }), false, "a real Twilio SID");
  assert.equal(isSimulatedMessage({ provider_message_id: null }), false);
  assert.match(SIMULATED_SMS_STATUS_REASON, /^SIMULATED: no SMS was sent and no phone was contacted/);
});

test("the person timeline labels a simulated send as not sent - never as sent or a note", () => {
  assert.equal(messageTimelineLabel({ direction: "outbound", status: "logged", sender_type: "user", provider_message_id: "sim_abc" }), "Simulated text (not sent)");
  assert.equal(messageTimelineLabel({ direction: "outbound", status: "logged", sender_type: "user", provider_message_id: null }), "Note added");
  assert.equal(messageTimelineLabel({ direction: "outbound", status: "sent", sender_type: "user", provider_message_id: "SM1" }), "You sent a message");
});
