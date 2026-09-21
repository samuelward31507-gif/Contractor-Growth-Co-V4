/**
 * Unit tests for the internal signup-notification email - pure logic and a
 * dependency-injected `send` callback, no real Resend API call and no
 * Supabase/network dependency at all. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/email/send-signup-notification.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const {
  buildSignupNotificationEmail,
  sendSignupNotification,
}: typeof import("./send-signup-notification") = require(path.join(REPO_ROOT, "lib/email/send-signup-notification.ts"));

const INPUT = { email: "new-contractor@example.com", userId: "user-123", signupTime: new Date("2026-01-15T10:00:00Z") };

test("1. subject line is exact", () => {
  const email = buildSignupNotificationEmail(INPUT);
  assert.equal(email.subject, "New Contractor Growth Co. Signup");
});

test("2. recipient defaults to contractorgrowthcompany@gmail.com when SIGNUP_NOTIFICATION_TO is unset", () => {
  const previous = process.env.SIGNUP_NOTIFICATION_TO;
  delete process.env.SIGNUP_NOTIFICATION_TO;
  try {
    const email = buildSignupNotificationEmail(INPUT);
    assert.equal(email.to, "contractorgrowthcompany@gmail.com");
  } finally {
    if (previous !== undefined) process.env.SIGNUP_NOTIFICATION_TO = previous;
  }
});

test("3. recipient honors SIGNUP_NOTIFICATION_TO when explicitly set", () => {
  const previous = process.env.SIGNUP_NOTIFICATION_TO;
  process.env.SIGNUP_NOTIFICATION_TO = "contractorgrowthcompany@gmail.com";
  try {
    const email = buildSignupNotificationEmail(INPUT);
    assert.equal(email.to, "contractorgrowthcompany@gmail.com");
  } finally {
    if (previous === undefined) delete process.env.SIGNUP_NOTIFICATION_TO;
    else process.env.SIGNUP_NOTIFICATION_TO = previous;
  }
});

test("4. body includes the customer email, signup time, user id, status, and next step - never a password", () => {
  const email = buildSignupNotificationEmail(INPUT);
  assert.match(email.text, /New signup received\./);
  assert.match(email.text, /Email:\s*\nnew-contractor@example\.com/);
  assert.match(email.text, /Signup time:\s*\n2026-01-15T10:00:00\.000Z/);
  assert.match(email.text, /User ID:\s*\nuser-123/);
  assert.match(email.text, /Account created — awaiting email confirmation/);
  assert.match(email.text, /Customer needs to confirm their email and complete onboarding\./);
  // The input type itself has no password field, and the rendered body must
  // never contain the word "password" under any circumstance.
  assert.doesNotMatch(email.text.toLowerCase(), /password/);
});

test("5. sendSignupNotification calls the injected send function exactly once with the built email", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "notifications@example.com";
  try {
    let callCount = 0;
    let received: unknown;
    await sendSignupNotification(INPUT, {
      send: async (email) => {
        callCount += 1;
        received = email;
        return {};
      },
    });
    assert.equal(callCount, 1, "the send function must be called exactly once per notification");
    assert.equal((received as { subject: string }).subject, "New Contractor Growth Co. Signup");
    assert.equal((received as { to: string }).to, "contractorgrowthcompany@gmail.com");
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});

test("6. sendSignupNotification never throws when the send function throws", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "notifications@example.com";
  try {
    await assert.doesNotReject(
      sendSignupNotification(INPUT, {
        send: async () => {
          throw new Error("simulated Resend network failure");
        },
      }),
    );
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});

test("7. sendSignupNotification never throws when the send function resolves with an error", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "notifications@example.com";
  try {
    await assert.doesNotReject(
      sendSignupNotification(INPUT, {
        send: async () => ({ error: { message: "invalid API key" } }),
      }),
    );
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});

test("8. sendSignupNotification skips (never calls send) when RESEND_API_KEY or EMAIL_FROM is missing", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  try {
    let callCount = 0;
    await sendSignupNotification(INPUT, {
      send: async () => {
        callCount += 1;
        return {};
      },
    });
    assert.equal(callCount, 0, "must not attempt to send when unconfigured");
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});
