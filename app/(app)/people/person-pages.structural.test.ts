/**
 * Phase 2-13 structural tests for the Person and contact pages, verified
 * against the real source files (the ui.structural.test.ts convention):
 *   D3  - opportunity types render through the shared registry label, never
 *         a page-local map or a raw type code;
 *   §3  - every next-step caller passes the conversations waiting on the
 *         business (lib/conversations/waiting), never the AI-off rule.
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/people/person-pages.structural.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const { OPPORTUNITY_TYPE_LABEL }: typeof import("@/lib/decisions/registry") = require(path.join(ROOT, "lib/decisions/registry.ts"));
const { OPPORTUNITY_VALUE_CLASS }: typeof import("@/lib/opportunities/queries") = require(path.join(ROOT, "lib/opportunities/queries.ts"));

const PERSON_PAGES = ["app/(app)/people/[id]/page.tsx", "app/(app)/contacts/[id]/page.tsx"];

test("D3: the Person and contact pages label opportunity types from the shared registry - no local map, no raw-code fallback", () => {
  for (const file of PERSON_PAGES) {
    const source = read(file);
    assert.match(source, /import \{ OPPORTUNITY_TYPE_LABEL \} from "@\/lib\/decisions\/registry";/, file);
    assert.doesNotMatch(source, /OPPORTUNITY_TYPE_LABELS/, `${file}: no page-local label map`);
    assert.doesNotMatch(source, /OPPORTUNITY_TYPE_LABEL\[[^\]]+\] \?\? /, `${file}: no fallback to the raw type code`);
  }
});

test("D3: the registry has a human label for every opportunity type", () => {
  for (const type of Object.keys(OPPORTUNITY_VALUE_CLASS)) {
    const label = OPPORTUNITY_TYPE_LABEL[type as keyof typeof OPPORTUNITY_TYPE_LABEL];
    assert.ok(label && label.length > 0 && !label.includes("_"), `${type} -> ${label}`);
  }
});

test("§3: every next-step caller passes the conversations waiting on the business", () => {
  for (const file of ["app/(app)/people/[id]/page.tsx", "app/(app)/people/page.tsx", "app/(app)/appointments/[id]/page.tsx", "app/(app)/conversations/[id]/page.tsx"]) {
    const source = read(file);
    assert.match(source, /getWaitingConversationIds\(supabase, membership\.organizationId/, file);
    assert.match(source, /waitingConversationIds: waiting\.ids/, file);
  }
  assert.doesNotMatch(read("lib/people/next-step.ts"), /ai_enabled/, "AI on/off is not part of waiting");
  assert.doesNotMatch(read("lib/notifications/owner-digest.ts"), /ai_enabled/, "the digest's waiting count is not the AI-off count");
});

// ---------------------------------------------------------------------------
// Phase 3 (W1/W2)
// ---------------------------------------------------------------------------

test("Phase 3 (W2): the Person page reads this person's own records by contact - never the organization's whole lists filtered in memory", () => {
  const source = read("app/(app)/people/[id]/page.tsx");
  for (const call of ["getContactLeads(supabase, membership.organizationId, id)", "getAppointmentsForContact(supabase, membership.organizationId, id)", "getContactEstimates(supabase, membership.organizationId, id)", "getContactConversations(supabase, membership.organizationId, id)", "getContactJobs(supabase, membership.organizationId, id)"]) {
    assert.ok(source.includes(call), call);
  }
  assert.doesNotMatch(source, /\bget(Leads|Appointments|Estimates|Conversations|Jobs)\(supabase, membership\.organizationId\)/, "no org-wide list reads");
});

test("Phase 3 (W1): the Person page names its lead-value stat honestly; the People list passes the organization's timezone to the next step", () => {
  const person = read("app/(app)/people/[id]/page.tsx");
  assert.match(person, /label: "Open lead value"/);
  assert.doesNotMatch(person, /label: "Open opportunity value"/);
  const people = read("app/(app)/people/page.tsx");
  assert.match(people, /getOrganizationTimezone\(supabase, membership\.organizationId\)/);
  assert.match(people, /invoices: invoicesByContactId\.get\(contact\.id\) \?\? \[\],\n\s+timeZone,/);
});

test("Phase 3 (W1): Inbox 'needs a reply' is the canonical waiting rule, not 'the last message is inbound'", () => {
  const list = read("app/(app)/conversations/_components/conversations-list.tsx");
  assert.match(list, /return conversation\.status === "open" && waitingIds\.has\(conversation\.id\);/);
  assert.doesNotMatch(list, /lastMessage\?\.direction === "inbound"/);
  const layout = read("app/(app)/conversations/layout.tsx");
  assert.match(layout, /getWaitingConversationIds\(supabase, membership\.organizationId\)/);
  assert.match(layout, /waitingConversationIds=\{\[\.\.\.waiting\.ids\]\}/);
});

test("Phase 3 (W1): the automation history empty state never claims the automation is configured", () => {
  const source = read("app/(app)/automations/_components/recent-executions.tsx");
  assert.doesNotMatch(source, /configured but/);
});
