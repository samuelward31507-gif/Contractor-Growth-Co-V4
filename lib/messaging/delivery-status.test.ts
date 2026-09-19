/**
 * Unit tests for mapTwilioMessageStatus() - pure, no I/O. Run with:
 *
 *   node --test lib/messaging/delivery-status.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mapTwilioMessageStatus }: typeof import("./delivery-status") = require("./delivery-status.ts");

test("accepted/queued map to Trackpr's queued (rank 0)", () => {
  assert.deepEqual(mapTwilioMessageStatus("accepted"), { status: "queued", rank: 0 });
  assert.deepEqual(mapTwilioMessageStatus("queued"), { status: "queued", rank: 0 });
});

test("sending/sent map to Trackpr's sent (rank 1)", () => {
  assert.deepEqual(mapTwilioMessageStatus("sending"), { status: "sent", rank: 1 });
  assert.deepEqual(mapTwilioMessageStatus("sent"), { status: "sent", rank: 1 });
});

test("delivered/undelivered/failed map 1:1 to Trackpr's own names, all rank 2 (terminal)", () => {
  assert.deepEqual(mapTwilioMessageStatus("delivered"), { status: "delivered", rank: 2 });
  assert.deepEqual(mapTwilioMessageStatus("undelivered"), { status: "undelivered", rank: 2 });
  assert.deepEqual(mapTwilioMessageStatus("failed"), { status: "failed", rank: 2 });
});

test("case-insensitive and trims whitespace", () => {
  assert.deepEqual(mapTwilioMessageStatus("  DELIVERED  "), { status: "delivered", rank: 2 });
});

test("unrecognized statuses (read, canceled, scheduled, garbage) are rejected, never guessed at", () => {
  assert.equal(mapTwilioMessageStatus("read"), null);
  assert.equal(mapTwilioMessageStatus("canceled"), null);
  assert.equal(mapTwilioMessageStatus("scheduled"), null);
  assert.equal(mapTwilioMessageStatus("some-future-twilio-status"), null);
  assert.equal(mapTwilioMessageStatus(""), null);
});
