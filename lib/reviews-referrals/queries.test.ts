/**
 * Unit tests for summarizeReviewRequests()/summarizeReferralRequests() -
 * pure, no I/O. Run with:
 *
 *   node --test lib/reviews-referrals/queries.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeReviewRequests, summarizeReferralRequests }: typeof import("./queries") = require("./queries.ts");

function reviewRow(status: string) {
  return { id: status, organization_id: "org", job_id: status, contact_id: null, conversation_id: null, message_id: null, workflow_execution_id: null, status, review_url: null, requested_at: null, responded_at: null, resolved_at: null, failure_reason: null, created_at: "", updated_at: "" } as never;
}

function referralRow(status: string) {
  return { id: status, organization_id: "org", job_id: status, contact_id: null, conversation_id: null, message_id: null, workflow_execution_id: null, status, referred_lead_id: null, requested_at: null, responded_at: null, resolved_at: null, failure_reason: null, created_at: "", updated_at: "" } as never;
}

test("summarizeReviewRequests: total requested is every row (a row only ever exists once requested)", () => {
  const summary = summarizeReviewRequests([reviewRow("requested"), reviewRow("responded"), reviewRow("completed"), reviewRow("declined"), reviewRow("failed")]);
  assert.equal(summary.reviewsRequested, 5);
  assert.equal(summary.reviewsResponded, 1);
  assert.equal(summary.reviewsCompleted, 1);
  assert.equal(summary.reviewsDeclined, 1);
  assert.equal(summary.reviewsFailed, 1);
});

test("summarizeReviewRequests: empty list is all zeros, not an error", () => {
  const summary = summarizeReviewRequests([]);
  assert.deepEqual(summary, { reviewsRequested: 0, reviewsResponded: 0, reviewsCompleted: 0, reviewsDeclined: 0, reviewsFailed: 0 });
});

test("summarizeReferralRequests: total requested is every row, per-status counts sum back to it", () => {
  const summary = summarizeReferralRequests([referralRow("requested"), referralRow("responded"), referralRow("converted"), referralRow("declined"), referralRow("failed"), referralRow("failed")]);
  assert.equal(summary.referralsRequested, 6);
  assert.equal(summary.referralsResponded, 1);
  assert.equal(summary.referralsConverted, 1);
  assert.equal(summary.referralsDeclined, 1);
  assert.equal(summary.referralsFailed, 2);
});
