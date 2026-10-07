/**
 * Batch 3 consistency fix - the cross-surface actor invariant, end to end:
 * one waiting conversation, among five or more, resolves to the SAME actor
 * on Today, Person and Inbox, inside Trackpr's reply window and after it.
 *
 * Every surface runs its real context loader against the same fake data:
 *   Today  - getDecisionContext(dashboard attention items, capped list) -> assembleDecisions
 *   Person - getSurfaceDecisionContext(the person's waiting ids)       -> presentNextStep
 *   Inbox  - getSurfaceDecisionContext(the org's waiting ids)          -> presentConversationOwner
 * so a surface that falls back to a different actor because of how many
 * conversations are waiting (the old C5 cap, or a capped id slice) fails here.
 *
 * Offline: no network, no database.
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/actor-consistency.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getDecisionContext }: typeof import("./context") = require(path.join(ROOT, "lib/decisions/context.ts"));
const { getSurfaceDecisionContext }: typeof import("./surface-context") = require(path.join(ROOT, "lib/decisions/surface-context.ts"));
const { assembleDecisions }: typeof import("./assemble") = require(path.join(ROOT, "lib/decisions/assemble.ts"));
const { presentConversationOwner, presentNextStep }: typeof import("./presentation") = require(path.join(ROOT, "lib/decisions/presentation.ts"));

type AttentionItem = import("@/lib/dashboard/queries").AttentionItem;
type Read = { table: string; inIds?: unknown[] };
type Result = { data: unknown; error: { message: string } | null };

// Wednesday 2026-10-07, 15:00 UTC.
const NOW = Date.parse("2026-10-07T15:00:00.000Z");
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const TARGET = "conv-target";
/** Seven conversations waiting org-wide; Today's dashboard SQL returns at most five of them, the target among them. */
const OTHERS = ["conv-2", "conv-3", "conv-4", "conv-5", "conv-6", "conv-7"];
const ORG_WAITING = [...OTHERS, TARGET];
const TODAY_WAITING = [OTHERS[0], OTHERS[1], OTHERS[2], OTHERS[3], TARGET];

/** One fake organization: live, AI on, inbound replies on (ignoring business hours); every conversation's own messages. */
function fakeOrg(targetWaitingMinutes: number) {
  const rowFor = (id: string) => ({
    id,
    ai_enabled: true,
    contact: { sms_opt_out: false },
    messages: [{ created_at: ago((id === TARGET ? targetWaitingMinutes : 120) * MIN), direction: "inbound", status: "received" }],
  });
  const results: Record<string, (read: Read) => Result> = {
    organizations: () => ({ data: { automation_mode: "live", payment_status: "active", automation_paused: false }, error: null }),
    ai_settings: () => ({ data: { ai_enabled: true }, error: null }),
    automation_settings: () => ({ data: [{ automation_id: "inbound-customer-reply", enabled: true, config: { respect_business_hours: false } }], error: null }),
    conversations: (read) => ({ data: (read.inIds ?? []).map((id) => rowFor(String(id))), error: null }),
  };
  return {
    from(table: string) {
      const read: Read = { table };
      const result = (): Result => results[table]?.(read) ?? { data: [], error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        in: (_column: string, values: unknown[]) => ((read.inIds = values), builder),
        range: () => Promise.resolve(result()),
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const waitingItem = (conversationId: string): AttentionItem => ({ id: `reply-${conversationId}`, kind: "awaiting_reply", title: conversationId === TARGET ? "Ann Lee" : "Someone", detail: "Waiting", value: null, href: `/conversations/${conversationId}`, conversationId });

async function actorsOnEverySurface(targetWaitingMinutes: number) {
  // Today: the capped dashboard list (five waiting), through the assembler.
  const todayContext = await getDecisionContext(fakeOrg(targetWaitingMinutes), "org-1", { attentionItems: TODAY_WAITING.map(waitingItem), timeZone: "UTC", now: NOW });
  const today = assembleDecisions({ attentionItems: TODAY_WAITING.map(waitingItem), prioritizedOpportunities: [], context: todayContext });
  const isTarget = (item: { subject: { href: string } }) => item.subject.href === `/conversations/${TARGET}`;
  const todayActor = today.trackprHandling.some(isTarget) ? "trackpr" : today.attention.some(isTarget) ? "you" : "absent";

  // Person: the person's own waiting conversation only.
  const personContext = await getSurfaceDecisionContext(fakeOrg(targetWaitingMinutes), "org-1", { waitingConversationIds: new Set([TARGET]), timeZone: "UTC", now: NOW });
  const person = presentNextStep({ label: "Needs your attention", detail: "A conversation is waiting for a reply.", href: `/conversations/${TARGET}`, attention: true }, { stage: "conversing" }, {
    contactId: "contact-ann",
    contactPhone: "+15125550101",
    contactSmsOptOut: false,
    conversations: [{ id: TARGET, status: "open" }],
    waitingConversationIds: new Set([TARGET]),
    estimates: [],
    context: personContext,
  });

  // Inbox: every waiting conversation in the organization (seven), the target listed LAST.
  const inboxContext = await getSurfaceDecisionContext(fakeOrg(targetWaitingMinutes), "org-1", { waitingConversationIds: new Set(ORG_WAITING), timeZone: "UTC", now: NOW });
  const inbox = presentConversationOwner({ id: TARGET, status: "open", ai_enabled: true }, new Set(ORG_WAITING), inboxContext);

  return { todayActor, personActor: person?.owner, inboxActor: inbox.owner, inboxNeedsYou: inbox.needsYou, todayContext };
}

test("inside Trackpr's reply window, with 7 conversations waiting (5 on Today's capped list): Today, Person and Inbox all say Trackpr", async () => {
  const result = await actorsOnEverySurface(5);
  assert.equal(result.todayContext.waitingConversations.size, 5, "Today still reads only its capped list");
  assert.equal(result.todayActor, "trackpr", "Today");
  assert.equal(result.personActor, "trackpr", "Person");
  assert.equal(result.inboxActor, "trackpr", "Inbox");
  assert.equal(result.inboxNeedsYou, false);
});

test("after the reply window: the same record is the contractor's on Today, Person and Inbox", async () => {
  const result = await actorsOnEverySurface(40);
  assert.equal(result.todayActor, "you", "Today");
  assert.equal(result.personActor, "you", "Person");
  assert.equal(result.inboxActor, "you", "Inbox");
  assert.equal(result.inboxNeedsYou, true);
});

test("the other waiting conversations (2h old) are the contractor's everywhere too - list position never changes the answer", async () => {
  const result = await actorsOnEverySurface(5);
  const inboxContext = await getSurfaceDecisionContext(fakeOrg(5), "org-1", { waitingConversationIds: new Set(ORG_WAITING), timeZone: "UTC", now: NOW });
  for (const id of OTHERS) assert.equal(presentConversationOwner({ id, status: "open", ai_enabled: true }, new Set(ORG_WAITING), inboxContext).owner, "you", id);
  assert.equal(result.todayActor, "trackpr");
});
