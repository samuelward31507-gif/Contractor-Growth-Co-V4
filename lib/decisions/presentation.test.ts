/**
 * Batch 3 (core daily loop): actor presentation across Today, People,
 * Person, Inbox and Schedule. The rules under test are lib/decisions/
 * actor.ts's own; these tests prove every surface reads them the same way.
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/presentation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ALL_HUMAN_CONTEXT, type DecisionContext } from "./actor";
import { assembleDecisions } from "./assemble";
import { nextStepLine, ownerForDecision, presentConversationOwner, presentNextStep, trackprHandlingSentence, waitingIdsAsAttentionItems, type PersonActorInput } from "./presentation";
import { buildAgenda, describeAppointment } from "../appointments/agenda";
import { SENDER_INITIALS, SENDER_LABELS } from "../conversations/format";
import type { NextStep } from "../people/next-step";

const require = createRequire(import.meta.url);
const { buildParityFixture }: typeof import("./assemble.fixture") = require("./assemble.fixture.ts");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-07T17:00:00Z");
const read = (file: string) => fs.readFileSync(file, "utf8");

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    now: NOW,
    organizationEligible: true,
    aiSettingsEnabled: true,
    inboundReplyEnabled: true,
    estimateFollowupEnabled: true,
    inboundReplyWithinHours: true,
    waitingCapReached: false,
    waitingConversations: new Map(),
    estimateContactAiDisabled: new Set(),
    ...overrides,
  };
}

const waitingState = (minutesAgo: number) => ({ aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: new Date(NOW - minutesAgo * MIN).toISOString() });

function person(overrides: Partial<PersonActorInput> = {}): PersonActorInput {
  return {
    contactId: "c6",
    contactPhone: "+15125550106",
    contactSmsOptOut: false,
    conversations: [],
    waitingConversationIds: new Set(),
    estimates: [],
    context: context(),
    ...overrides,
  };
}

const step = (label: string, href: string, attention: boolean, detail?: string): NextStep => ({ label, href, attention, detail });

// ---------------------------------------------------------------------------
// Person / People: one owner per next step
// ---------------------------------------------------------------------------

test("a customer waiting inside Trackpr's reply window is Trackpr's - no action for the contractor", () => {
  const input = person({
    conversations: [{ id: "conv-1", status: "open" }],
    waitingConversationIds: new Set(["conv-1"]),
    context: context({ waitingConversations: new Map([["conv-1", waitingState(5)]]) }),
  });
  const view = presentNextStep(step("Needs your attention", "/conversations/conv-1", true, "A conversation is waiting for a reply."), { stage: "conversing", primary: null }, input);
  assert.equal(view?.owner, "trackpr");
  assert.equal(view?.needsYou, false);
  assert.equal(view?.headline, "Trackpr is replying to the customer");
  assert.equal(view?.href, "/conversations/conv-1", "the way in is still the conversation");
});

test("the same wait past the grace period (or with AI off, or opted out) is the contractor's, and urgent", () => {
  for (const ctx of [
    context({ waitingConversations: new Map([["conv-1", waitingState(40)]]) }),
    context({ waitingConversations: new Map([["conv-1", { ...waitingState(5), aiEnabled: false }]]) }),
    context({ waitingConversations: new Map([["conv-1", { ...waitingState(5), smsOptOut: true }]]) }),
    context({ aiSettingsEnabled: false, waitingConversations: new Map([["conv-1", waitingState(5)]]) }),
    context({ waitingCapReached: true, waitingConversations: new Map([["conv-1", waitingState(5)]]) }),
  ]) {
    const view = presentNextStep(step("Needs your attention", "/conversations/conv-1", true), { stage: "conversing" }, person({ conversations: [{ id: "conv-1", status: "open" }], waitingConversationIds: new Set(["conv-1"]), context: ctx }));
    assert.equal(view?.owner, "you");
    assert.equal(view?.needsYou, true);
    assert.equal(view?.headline, "Reply to the customer");
  }
});

test("a sent estimate inside the follow-up window is Trackpr's; outside it the contractor's; unreachable or automation off, the customer's decision or yours", () => {
  const estimate = (hoursAgo: number) => [{ id: "est-1", status: "sent", sent_at: new Date(NOW - hoursAgo * HOUR).toISOString(), title: "Deck" }];
  const sentStep = step("Estimate awaiting response", "/estimates/est-1", false, "Deck");
  const followStep = step("Follow up on estimate", "/estimates/est-1", true, "Deck");

  const handled = presentNextStep(followStep, { stage: "estimate_follow_up", primary: { type: "estimate", id: "est-1" } }, person({ estimates: estimate(30) }));
  assert.deepEqual([handled?.owner, handled?.headline, handled?.needsYou], ["trackpr", "Trackpr is following up on the estimate", false], "the lifecycle says 'follow up', but Trackpr's second touch is still pending - so it is Trackpr's, as on Today");

  const missed = presentNextStep(followStep, { stage: "estimate_follow_up", primary: { type: "estimate", id: "est-1" } }, person({ estimates: estimate(80) }));
  assert.deepEqual([missed?.owner, missed?.headline, missed?.needsYou], ["you", "Follow up on the estimate", true]);

  const automationOff = presentNextStep(sentStep, { stage: "estimate_sent", primary: { type: "estimate", id: "est-1" } }, person({ estimates: estimate(2), context: context({ estimateFollowupEnabled: false }) }));
  assert.deepEqual([automationOff?.owner, automationOff?.headline, automationOff?.needsYou], ["customer", "Waiting on the customer's decision", false]);

  const optedOut = presentNextStep(followStep, { stage: "estimate_follow_up", primary: { type: "estimate", id: "est-1" } }, person({ estimates: estimate(30), contactSmsOptOut: true }));
  assert.equal(optedOut?.owner, "you", "an opted-out customer can't be followed up by Trackpr");
});

test("every other next step is the contractor's, word for word, with the step's own urgency", () => {
  const view = presentNextStep(step("Create the job", "/estimates/e2", true, "Estimate accepted · Deck"), { stage: "won", primary: { type: "estimate", id: "e2" } }, person());
  assert.deepEqual([view?.owner, view?.headline, view?.detail, view?.href, view?.needsYou], ["you", "Create the job", "Estimate accepted · Deck", "/estimates/e2", true]);
  const calm = presentNextStep(step("Job in progress", "/jobs/j1", false), { stage: "job_active" }, person());
  assert.equal(calm?.needsYou, false);
  assert.equal(nextStepLine(view!), "You · Create the job");
  assert.equal(presentNextStep(null, { stage: "paid" }, person()), null);
});

// ---------------------------------------------------------------------------
// Cross-page: Today's assembler and the Person/People presenter agree
// ---------------------------------------------------------------------------

test("cross-page: one pending estimate - Today puts it under 'Trackpr is handling' exactly when People/Person say Trackpr, and in 'Needs you' exactly when they say You", () => {
  for (const [hoursAgo, expected] of [
    [30, "trackpr"],
    [80, "you"],
  ] as const) {
    const fixture = buildParityFixture(NOW);
    const base = fixture.prioritizedOpportunities.find((p) => p.opportunity.id === "o6")!;
    const sentAt = new Date(NOW - hoursAgo * HOUR).toISOString();
    const prioritized = { ...base, contactPhone: "+15125550106", contactSmsOptOut: false, opportunity: { ...base.opportunity, metadata: { estimate_id: "est-9", sent_at: sentAt } } };
    const today = assembleDecisions({ attentionItems: [], prioritizedOpportunities: [prioritized], context: context() });
    const todayOwner = today.trackprHandling.some((item) => item.key === "opportunity:o6") ? "trackpr" : today.attention.some((item) => item.key === "opportunity:o6") ? "you" : "absent";

    const personView = presentNextStep(step("Follow up on estimate", "/estimates/src-o6", true), { stage: "estimate_follow_up", primary: { type: "estimate", id: "src-o6" } }, person({
      estimates: [{ id: "src-o6", status: "sent", sent_at: sentAt }],
      openOpportunities: [prioritized.opportunity],
    }));
    assert.equal(todayOwner, expected, `Today, sent ${hoursAgo}h ago`);
    assert.equal(personView?.owner, expected, `Person/People, sent ${hoursAgo}h ago`);
    if (expected === "trackpr") {
      const item = today.trackprHandling[0];
      assert.equal(ownerForDecision(item), "trackpr");
      assert.equal(trackprHandlingSentence(item), "Following up on Person o6's estimate");
    }
  }
});

test("cross-page: one waiting conversation - Today, Person and Inbox agree on who replies", () => {
  for (const [minutesAgo, expected] of [
    [5, "trackpr"],
    [40, "you"],
  ] as const) {
    const ctx = context({ waitingConversations: new Map([["conv-a", waitingState(minutesAgo)]]) });
    const fixture = buildParityFixture(NOW);
    const signal = fixture.attentionItems.find((item) => item.id === "reply-a")!;
    const today = assembleDecisions({ attentionItems: [{ ...signal, conversationId: "conv-a" }], prioritizedOpportunities: [], context: ctx });
    const todayOwner = today.trackprHandling.length === 1 ? "trackpr" : today.attention.length === 1 ? "you" : "absent";

    const personView = presentNextStep(step("Needs your attention", "/conversations/conv-a", true), { stage: "conversing" }, person({ conversations: [{ id: "conv-a", status: "open" }], waitingConversationIds: new Set(["conv-a"]), context: ctx }));
    const inbox = presentConversationOwner({ id: "conv-a", status: "open", ai_enabled: true }, new Set(["conv-a"]), ctx);

    assert.equal(todayOwner, expected, `Today, waiting ${minutesAgo}m`);
    assert.equal(personView?.owner, expected, `Person, waiting ${minutesAgo}m`);
    assert.equal(inbox.owner, expected, `Inbox, waiting ${minutesAgo}m`);
    assert.equal(inbox.needsYou, expected === "you");
    if (expected === "trackpr") assert.equal(trackprHandlingSentence(today.trackprHandling[0]), "Replying to Ann Lee");
  }
});

test("off Today, the waiting ids feed Today's own context read, capped exactly as the dashboard SQL caps them", () => {
  assert.deepEqual(waitingIdsAsAttentionItems(["a", "b"], 5).map((item) => [item.kind, item.conversationId]), [["awaiting_reply", "a"], ["awaiting_reply", "b"]]);
  assert.equal(waitingIdsAsAttentionItems(["a", "b", "c", "d", "e", "f", "g"], 5).length, 5, "at the cap getDecisionContext marks every wait as the contractor's");
  const surface = read("lib/decisions/surface-context.ts");
  assert.match(surface, /getDecisionContext\(supabase, organizationId, \{ attentionItems, timeZone: input\.timeZone, now: input\.now \}\)/, "the one context reader, unchanged");
  assert.doesNotMatch(read("lib/decisions/presentation.ts"), /from "@\/lib\/lifecycle\//, "presentation never imports the canonical lifecycle model");
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

test("Inbox: closed belongs to nobody; an answered conversation is Trackpr's only when Trackpr could answer the next message", () => {
  assert.deepEqual(presentConversationOwner({ id: "x", status: "closed", ai_enabled: true }, new Set(["x"]), context()), { owner: null, label: "Closed", needsYou: false });
  assert.deepEqual(presentConversationOwner({ id: "x", status: "open", ai_enabled: true }, new Set(), context()), { owner: "trackpr", label: "Trackpr is handling this", needsYou: false });
  for (const ctx of [context({ organizationEligible: false }), context({ aiSettingsEnabled: false }), context({ inboundReplyEnabled: false })]) {
    assert.equal(presentConversationOwner({ id: "x", status: "open", ai_enabled: true }, new Set(), ctx).owner, "you");
  }
  assert.deepEqual(presentConversationOwner({ id: "x", status: "open", ai_enabled: false }, new Set(), context()), { owner: "you", label: "You're handling this", needsYou: false });
  assert.deepEqual(presentConversationOwner({ id: "x", status: "open", ai_enabled: true }, new Set(["x"]), ALL_HUMAN_CONTEXT), { owner: "you", label: "Needs your reply", needsYou: true });
});

test("Inbox: opens on 'Needs you', keeps every conversation one tap away, and is reassuring when nothing needs you", () => {
  const workspace = read("app/(app)/conversations/_components/conversations-workspace.tsx");
  assert.match(workspace, /useState<"needs-you" \| "all">\("needs-you"\)/);
  assert.match(workspace, /if \(inboxView === "needs-you"\) return matching\.filter\(\(conversation\) => ownerById\[conversation\.id\]\?\.needsYou\);/);
  const list = read("app/(app)/conversations/_components/conversations-list.tsx");
  assert.match(list, /Nothing needs your attention/);
  assert.match(list, /Trackpr is handling the conversations it can\./);
  assert.match(list, /Show all conversations/);
  assert.doesNotMatch(list, /AI<\/Badge>|icon=\{Bot\}/, "no bare 'AI' badge - the owner line says who is on it");
  const layout = read("app/(app)/conversations/layout.tsx");
  assert.match(layout, /presentConversationOwner\(conversation, waiting\.ids, actorContext\)/);
});

test("Inbox: Trackpr is the sender's name, never 'AI'", () => {
  assert.equal(SENDER_LABELS.ai, "Trackpr");
  assert.equal(SENDER_INITIALS.ai, "T");
  assert.equal(SENDER_LABELS.user, "You");
});

// ---------------------------------------------------------------------------
// Person: texting goes through the business conversation, never sms:
// ---------------------------------------------------------------------------

test("Person: Text opens the person's text conversation in the Inbox - never an sms: link to the owner's phone", () => {
  const page = read("app/(app)/people/[id]/page.tsx");
  assert.doesNotMatch(page, /href=\{`sms:/, "no owner-phone sms: link");
  assert.doesNotMatch(page, /["'`]sms:/);
  assert.match(page, /conversations\.find\(\(conversation\) => conversation\.channel === "sms" && conversation\.status === "open"\) \?\? conversations\.find\(\(conversation\) => conversation\.channel === "sms"\) \?\? null/);
  assert.match(page, /<Link href=\{`\/conversations\/\$\{smsConversation\.id\}`\} aria-label=\{`Text \$\{name\} from your business number`\}/);
  assert.match(page, /No text conversation yet/, "without a text conversation it says so - it never creates one or falls back to the owner's phone");
  // The composer there is the one business path.
  const composer = read("app/(app)/conversations/[id]/_components/message-composer.tsx");
  assert.match(composer, /sendConversationMessage/);
  const actions = read("app/(app)/conversations/actions.ts");
  assert.match(actions, /const gate = await evaluateStaffOutboundGate\(supabase, \{ organizationId, conversationId, body \}\);/);
  assert.match(actions, /const result = await sendOutboundMessage\(supabase, \{/);
});

test("Person: one 'what happens next' block, owned, from the same lifecycle the badge reads", () => {
  const page = read("app/(app)/people/[id]/page.tsx");
  assert.match(page, /const canonicalLifecycle = derivePersonLifecycle\(personRows\);/);
  assert.match(page, /lifecycle: canonicalLifecycle,\n\s+\}\);\n\s+const nextView = presentNextStep\(nextStep, canonicalLifecycle,/);
  assert.match(page, /const relationshipStage = contactLifecycleFromCanonical\(canonicalLifecycle\);/);
  assert.equal((page.match(/<PersonNextStep /g) ?? []).length, 1, "one next-action block");
  assert.match(page, /<PersonNextStep nextView=\{nextView\} personName=\{name\} \/>/);
  const block = read("app/(app)/people/[id]/_components/person-next-step.tsx");
  assert.equal((block.match(/What happens next/g) ?? []).length, 1);
  assert.match(block, /<OwnerChip owner=\{nextView\.owner\} urgent=\{nextView\.needsYou\} \/>/);
  assert.match(block, /Nothing for you to do right now\./, "someone else's move says so");
  assert.doesNotMatch(page, /\{nextStep\.label\}/, "the raw step label is never shown beside the owned one");
});

test("People: every row's next step carries its owner, and only the contractor's urgent move takes the warning tone", () => {
  const page = read("app/(app)/people/page.tsx");
  assert.match(page, /presentNextStep\(step, lifecycle, \{/);
  const table = read("app/(app)/people/_components/people-table.tsx");
  assert.match(table, /<OwnerChip owner=\{nextStep\.owner\} urgent=\{nextStep\.needsYou\} \/>/);
  assert.match(table, /tone=\{nextStep\?\.needsYou \? "warning" : "neutral"\}/);
  assert.match(table, /href=\{`\/people\/\$\{contact\.id\}`\}/, "rows link to the canonical Person page");
});

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

test("Today: the caught-up state reassures, and Trackpr's work is worded as outcomes", () => {
  const page = read("app/(app)/today/page.tsx");
  assert.match(page, /You&apos;re all caught up\./);
  assert.match(page, /Trackpr is handling everything it can\. We&apos;ll let you know when something needs you\./);
  for (const sentence of ["Replying to Ann Lee", "Following up on Jo's estimate"]) assert.doesNotMatch(sentence, /workflow|automation|execution|agent|node|callback/i);
  assert.equal(trackprHandlingSentence({ reasonCode: "estimate_awaiting_decision", subject: { name: "Jo", href: "/people/1" }, problemLabel: "x" }), "Following up on Jo's estimate");
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const appt = (id: string, start: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Visit ${id}`,
  start_at: start,
  end_at: new Date(Date.parse(start) + HOUR).toISOString(),
  status: status as "scheduled",
  confirmed_at: null,
  confirmation_requested_at: null,
  contact: { first_name: "Pat", last_name: id },
  ...extra,
});

test("Schedule agenda: un-closed past visits first, then today in time order, then the next two weeks by day - cancelled and far-off visits left out", () => {
  const tz = "America/Chicago"; // NOW = 12:00 PM CDT
  const agenda = buildAgenda(
    [
      appt("late", "2026-10-07T21:00:00Z", "confirmed"),
      appt("early", "2026-10-07T14:00:00Z", "scheduled"),
      appt("cancelled-today", "2026-10-07T19:00:00Z", "cancelled"),
      appt("tomorrow", "2026-10-08T15:00:00Z", "scheduled"),
      appt("next-week", "2026-10-14T15:00:00Z", "confirmed"),
      appt("far", "2026-11-30T15:00:00Z", "scheduled"),
      appt("unclosed", "2026-10-05T15:00:00Z", "scheduled"),
      appt("closed", "2026-10-05T16:00:00Z", "completed"),
    ],
    new Date(NOW),
    tz,
  );
  assert.deepEqual(agenda.needsClosing.map((row) => row.id), ["unclosed"]);
  assert.deepEqual(agenda.today.map((row) => row.id), ["early", "late"], "today, in time order, never cancelled");
  assert.deepEqual(agenda.upcoming.map((group) => [group.label, group.rows.map((row) => row.id)]), [
    ["Tomorrow", ["tomorrow"]],
    ["Wednesday, Oct 14", ["next-week"]],
  ]);
  assert.equal(agenda.today[0].contactName, "Pat early");
});

test("Schedule agenda: every line is a stored fact, with its owner", () => {
  const future = "2026-10-08T15:00:00Z";
  assert.deepEqual(describeAppointment(appt("a", future, "confirmed"), NOW), { owner: "you", line: "Confirmed · you're meeting them", needsYou: false });
  assert.deepEqual(describeAppointment(appt("a", future, "scheduled", { confirmed_at: future, confirmation_requested_at: future }), NOW), { owner: "you", line: "Confirmed after Trackpr's reminder · you're meeting them", needsYou: false });
  assert.deepEqual(describeAppointment(appt("a", future, "scheduled", { confirmation_requested_at: future }), NOW), { owner: "customer", line: "Trackpr sent a reminder · waiting for them to confirm", needsYou: false });
  assert.deepEqual(describeAppointment(appt("a", future, "scheduled"), NOW), { owner: "you", line: "Not confirmed yet · you're meeting them", needsYou: false });
  assert.deepEqual(describeAppointment(appt("a", "2026-10-05T15:00:00Z", "confirmed"), NOW), { owner: "you", line: "Visit time has passed · mark how it went", needsYou: true });
  assert.deepEqual(describeAppointment(appt("a", future, "completed"), NOW), { owner: null, line: "Completed", needsYou: false });
});

test("Schedule: no view opens the agenda; a calendar view or a bare date still opens the calendar; list is unchanged", () => {
  const page = read("app/(app)/schedule/page.tsx");
  assert.match(page, /if \(view === undefined && typeof params\.date !== "string"\) \{\n\s+return ScheduleAgendaPage\(\);/);
  assert.match(page, /return CalendarPage\(props as Parameters<typeof CalendarPage>\[0\]\);/);
  assert.match(page, /return AppointmentsPage\(/);
  assert.match(read("app/(app)/schedule/_components/agenda-page.tsx"), /if \(!membership\) \{\n\s+redirect\("\/onboarding"\);/, "the agenda gates membership like every page");
  assert.match(read("app/(app)/schedule/_components/schedule-view-switcher.tsx"), /\{ value: "agenda", label: "Agenda" \}/);
});

test("the owner chip and Today's sections stay client-safe: they import only the dependency-free owner module, never the server-side actor model", () => {
  const owner = read("lib/decisions/owner.ts");
  assert.doesNotMatch(owner, /^import (?!type )/m, "owner.ts has no runtime imports");
  for (const file of ["lib/ui/owner-chip.tsx", "app/(app)/today/_components/dashboard-sections.tsx", "app/(app)/conversations/_components/conversations-list.tsx"]) {
    assert.doesNotMatch(read(file), /^import (?!type )[^\n]*from "@\/lib\/decisions\/(presentation|actor|context|surface-context)"/m, `${file} must not pull the actor model (and Twilio) into a client bundle`);
  }
});
