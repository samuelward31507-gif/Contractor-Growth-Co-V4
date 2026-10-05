/**
 * Estimate delivery: sending an estimate texts the customer the REAL
 * approval link through the normal outbound gate. Every database/network
 * dependency is mocked; the real content-safety screen and the real link
 * builder run. Nothing reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/estimate-delivery.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

const ESTIMATE = {
  id: "est-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  lead_id: "lead-1",
  title: "Roof replacement",
  amount: 12000,
  status: "sent",
  approval_token: "tok_abc123",
  contact: { id: "contact-1", first_name: "Sarah", last_name: "Johnson", company_name: null, phone: "+15550000000", email: null },
};

const state = {
  estimate: { ...ESTIMATE } as Record<string, unknown> | null,
  duplicate: false,
  gate: { allowed: false, reason: "organization_not_live" } as Record<string, unknown>,
  calls: [] as string[],
  eventInput: null as Record<string, unknown> | null,
  gateInput: null as Record<string, unknown> | null,
  sendInput: null as Record<string, unknown> | null,
  completion: null as Record<string, unknown> | null,
};

const sessionClient = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.estimate ? { organization_id: "org-1" } : null }) }) }) }),
};

mock.module(lib("lib/automation/events.ts"), {
  namedExports: {
    createAutomationEvent: async (_client: unknown, input: Record<string, unknown>) => {
      state.calls.push("createAutomationEvent");
      state.eventInput = input;
      return state.duplicate
        ? { ok: true, event: { id: "evt-1", organization_id: "org-1" }, duplicate: true, skipped: false }
        : { ok: true, event: { id: "evt-1", organization_id: "org-1" }, duplicate: false, skipped: false };
    },
  },
});
mock.module(lib("lib/automation/executions.ts"), {
  namedExports: {
    startWorkflowExecution: async (_client: unknown, _eventId: string, workflow: string) => {
      state.calls.push(`start:${workflow}`);
      return { ok: true, execution: { id: "exec-1", attempt: 1 } };
    },
    completeWorkflowExecution: async (_client: unknown, _id: string, metadata: Record<string, unknown>) => {
      state.calls.push("complete");
      state.completion = metadata;
      return { ok: true };
    },
  },
});
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    evaluateOutboundGate: async (_client: unknown, input: Record<string, unknown>) => {
      state.calls.push("gate");
      state.gateInput = input;
      return state.gate;
    },
  },
});
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async (_client: unknown, input: Record<string, unknown>) => {
      state.calls.push("sendOutboundMessage");
      state.sendInput = input;
      return { ok: true, messageId: "msg-1", conversationId: "conv-1", providerMessageId: "SM1" };
    },
  },
});
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => ({}) } });
mock.module(lib("lib/conversations/queries.ts"), { namedExports: { findOrCreateOpenConversation: async () => ({ id: "conv-1" }) } });
mock.module(lib("lib/estimates/queries.ts"), { namedExports: { getEstimate: async () => state.estimate } });
mock.module(lib("lib/settings/queries.ts"), { namedExports: { getBusinessProfile: async () => ({ name: "QA Fixture Roofing", timezone: "America/Denver" }) } });

const { deliverEstimateToCustomer, composeEstimateDeliveryBody, ESTIMATE_DELIVERY_WORKFLOW } = await import(lib("lib/automation/estimate-delivery.ts"));
const { evaluateContentSafety } = await import(lib("lib/automation/content-safety.ts"));
const { resolveCustomerLinkBaseUrl, buildEstimateApprovalUrl } = await import(lib("lib/estimates/approval-link.ts"));

const BASE = "https://preview.example.vercel.app";
const URL = `${BASE}/quote/tok_abc123`;

beforeEach(() => {
  state.estimate = { ...ESTIMATE };
  state.duplicate = false;
  state.gate = { allowed: false, reason: "organization_not_live" };
  state.calls = [];
  state.eventInput = state.gateInput = state.sendInput = state.completion = null;
});

test("the delivery text carries the real approval link and passes the gate's content-safety screen (no price, no invented-claim phrasing)", () => {
  const body = composeEstimateDeliveryBody({ firstName: "Sarah", businessName: "QA Fixture Roofing", title: "Roof replacement", approvalUrl: URL });
  assert.equal(body, `Hi Sarah, QA Fixture Roofing has sent you a quote for Roof replacement. Review and approve it here: ${URL}`);
  assert.deepEqual(evaluateContentSafety(body), { safe: true });
  assert.deepEqual(evaluateContentSafety(composeEstimateDeliveryBody({ firstName: null, businessName: null, title: "Gutter repair", approvalUrl: URL })), { safe: true });
});

test("TEST mode: the gate is evaluated with the real link and estimate-still-sent eligibility, blocks with organization_not_live, nothing is sent, and the block is recorded on the execution", async () => {
  const outcome = await deliverEstimateToCustomer(sessionClient as never, "est-1", BASE);

  assert.deepEqual(outcome, { status: "blocked", reason: "organization_not_live" });
  assert.deepEqual(state.calls, ["createAutomationEvent", `start:${ESTIMATE_DELIVERY_WORKFLOW}`, "gate", "complete"]);
  assert.equal(state.eventInput?.eventType, "estimate.delivery");
  assert.equal(state.eventInput?.idempotencyKey, "estimate.delivery:est-1");
  assert.equal((state.eventInput?.payload as Record<string, unknown>).approval_url, URL);
  const ai = state.gateInput?.aiResult as Record<string, unknown>;
  assert.ok(String(ai.response_message).endsWith(URL));
  assert.equal(state.gateInput?.estimateId, "est-1");
  assert.deepEqual(state.gateInput?.estimateEligibleStatuses, ["sent"]);
  assert.equal(state.gateInput?.executionId, "exec-1");
  assert.equal(state.completion?.blocked_reason, "organization_not_live");
  assert.equal(state.completion?.should_send, false);
  assert.equal(state.completion?.approval_url_included, true);
});

test("live (gate allows): exactly one outbound send, as a system message tied to the delivery execution", async () => {
  state.gate = { allowed: true, contactId: "contact-1", conversationId: "conv-1", body: `gated body ${URL}` };
  const outcome = await deliverEstimateToCustomer(sessionClient as never, "est-1", BASE);
  assert.deepEqual(outcome, { status: "sent", messageId: "msg-1" });
  assert.equal(state.calls.filter((call) => call === "sendOutboundMessage").length, 1);
  assert.equal(state.sendInput?.senderType, "system");
  assert.equal(state.sendInput?.workflowExecutionId, "exec-1");
  assert.equal(state.sendInput?.body, `gated body ${URL}`, "always the gate's body, never a re-composed one");
  assert.equal(state.completion?.should_send, true);
});

test("idempotent: a replayed send for the same estimate is a duplicate event - no execution, no gate, no send", async () => {
  state.duplicate = true;
  assert.deepEqual(await deliverEstimateToCustomer(sessionClient as never, "est-1", BASE), { status: "skipped", reason: "duplicate" });
  assert.deepEqual(state.calls, ["createAutomationEvent"]);
});

test("nothing is attempted for a non-sent estimate, an estimate without a contact, or with no link base", async () => {
  state.estimate = { ...ESTIMATE, status: "draft" };
  assert.deepEqual(await deliverEstimateToCustomer(sessionClient as never, "est-1", BASE), { status: "skipped", reason: "not_sent" });
  state.estimate = { ...ESTIMATE, contact_id: null };
  assert.deepEqual(await deliverEstimateToCustomer(sessionClient as never, "est-1", BASE), { status: "skipped", reason: "no_contact" });
  state.estimate = { ...ESTIMATE };
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await deliverEstimateToCustomer(sessionClient as never, "est-1", null), { status: "skipped", reason: "no_link_base" });
  } finally {
    console.error = original;
  }
  assert.deepEqual(state.calls, []);
});

test("approval links resolve against the issuing deployment's own database: Preview -> the preview itself, Production -> the canonical URL", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
  assert.equal(resolveCustomerLinkBaseUrl(null, env({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "app-git-branch.vercel.app", VERCEL_URL: "app-abc.vercel.app" })), "https://app-git-branch.vercel.app");
  assert.equal(resolveCustomerLinkBaseUrl(null, env({ VERCEL_ENV: "preview", VERCEL_URL: "app-abc.vercel.app" })), "https://app-abc.vercel.app");
  assert.equal(resolveCustomerLinkBaseUrl("app-host.vercel.app", env({ VERCEL_ENV: "preview" })), "https://app-host.vercel.app");
  assert.equal(buildEstimateApprovalUrl("https://x.example/", "tok 1"), "https://x.example/quote/tok%201");
});
