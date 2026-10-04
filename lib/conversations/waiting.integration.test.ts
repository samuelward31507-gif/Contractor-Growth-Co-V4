/**
 * Phase 2-13 (§3): getWaitingConversationIds against a real database (TEST)
 * - proves what the offline fake cannot: PostgREST's embedded filter on the
 * referenced messages table (inbound, or outbound that was sent/delivered),
 * the per-conversation newest-first limit, and the contact scope. One
 * disposable organization, removed afterwards; nothing else is touched.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/conversations/waiting.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("This integration test runs against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getWaitingConversationIds, getLatestEvidenceByConversation }: typeof import("./waiting") = require(path.join(REPO_ROOT, "lib/conversations/waiting.ts"));
const { getLastMessagesByConversationResult, getMessages }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/conversations/queries.ts"));

const service = createServiceRoleClient();
const MIN = 60 * 1000;
let organizationId = "";
const ids: Record<string, string> = {};
const contacts: Record<string, string> = {};

async function conversation(label: string, contactLabel: string, options: { status?: string; aiEnabled?: boolean } = {}) {
  if (!contacts[contactLabel]) {
    const { data, error } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Wait", last_name: contactLabel, phone: `+1555502${String(Object.keys(contacts).length).padStart(4, "0")}` }).select("id").single();
    assert.ifError(error);
    contacts[contactLabel] = data!.id;
  }
  const { data, error } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contacts[contactLabel], channel: "sms", status: options.status ?? "open", ai_enabled: options.aiEnabled ?? true }).select("id").single();
  assert.ifError(error);
  ids[label] = data!.id;
}

async function message(label: string, direction: "inbound" | "outbound", status: string, minutesAgo: number) {
  const { error } = await service.from("messages").insert({
    organization_id: organizationId, conversation_id: ids[label], direction, sender_type: direction === "inbound" ? "customer" : "user",
    body: `wait ${direction} ${status}`, status, created_at: new Date(Date.now() - minutesAgo * MIN).toISOString(),
  });
  assert.ifError(error);
}

before(async () => {
  const { data, error } = await service.from("organizations").insert({ name: "Waiting Definition Test Org (2-13)" }).select("id").single();
  assert.ifError(error);
  organizationId = data!.id;

  // One open SMS conversation per contact (conversations_org_contact_channel_open_key), so each has its own contact.
  await conversation("unanswered", "unanswered"); // customer wrote last
  await message("unanswered", "outbound", "delivered", 60);
  await message("unanswered", "inbound", "received", 10);

  await conversation("answered", "answered", { aiEnabled: false }); // AI off, but the business replied - not waiting
  await message("answered", "inbound", "received", 60);
  await message("answered", "outbound", "sent", 10);

  await conversation("failedReply", "failedReply"); // the reply failed - still waiting
  await message("failedReply", "inbound", "received", 60);
  await message("failedReply", "outbound", "failed", 10);

  await conversation("queuedReply", "queuedReply"); // a queued reply is not a successful one - still waiting
  await message("queuedReply", "inbound", "received", 60);
  await message("queuedReply", "outbound", "queued", 10);

  await conversation("closed", "closed", { status: "closed" }); // closed - never waiting
  await message("closed", "inbound", "received", 10);

  await conversation("outboundOnly", "outboundOnly"); // the business wrote first, no reply yet - not waiting
  await message("outboundOnly", "outbound", "delivered", 10);

  await conversation("noteAfter", "noteAfter"); // Phase 3: a logged note is not a reply - still waiting
  await message("noteAfter", "inbound", "received", 60);
  await message("noteAfter", "outbound", "logged", 10);

  await conversation("undeliveredAfter", "undeliveredAfter"); // Phase 3: an undelivered send is not a reply - still waiting
  await message("undeliveredAfter", "inbound", "received", 60);
  await message("undeliveredAfter", "outbound", "undelivered", 10);
});

after(async () => {
  for (const table of ["messages", "conversations", "contacts"]) await service.from(table).delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("real reads: waiting = the newest inbound-or-successful-outbound message is inbound; AI on/off is irrelevant; failed and queued replies do not count; closed conversations never wait", async () => {
  const result = await getWaitingConversationIds(service, organizationId);
  assert.equal(result.failed, false);
  assert.deepEqual([...result.ids].sort(), [ids.unanswered, ids.failedReply, ids.queuedReply, ids.noteAfter, ids.undeliveredAfter].sort());
});

test("real reads: the contact scope returns only that contact's waiting conversations", async () => {
  assert.deepEqual([...(await getWaitingConversationIds(service, organizationId, { contactId: contacts.unanswered })).ids], [ids.unanswered]);
  assert.deepEqual([...(await getWaitingConversationIds(service, organizationId, { contactId: contacts.answered })).ids], []);
});

test("Phase 3, real reads: latest evidence per open conversation - the newest inbound or successful outbound, skipping failed / queued / logged / undelivered", async () => {
  const { evidence, failed } = await getLatestEvidenceByConversation(service, organizationId);
  assert.equal(failed, false);
  const direction = (label: string) => evidence.get(ids[label])?.direction ?? null;
  assert.deepEqual(
    ["unanswered", "answered", "failedReply", "queuedReply", "closed", "outboundOnly", "noteAfter", "undeliveredAfter"].map((label) => [label, direction(label)]),
    [["unanswered", "inbound"], ["answered", "outbound"], ["failedReply", "inbound"], ["queuedReply", "inbound"], ["closed", null], ["outboundOnly", "outbound"], ["noteAfter", "inbound"], ["undeliveredAfter", "inbound"]],
  );
});

test("Phase 3, real reads: the Inbox's last message per conversation is each conversation's own newest message (any status), embedded and paged", async () => {
  const { data, failed } = await getLastMessagesByConversationResult(service, organizationId);
  assert.equal(failed, false);
  assert.equal(data.get(ids.failedReply)?.status, "failed", "the true last message, even a failed one - activity, not evidence");
  assert.equal(data.get(ids.noteAfter)?.status, "logged");
  assert.equal(data.get(ids.unanswered)?.direction, "inbound");
});

test("Phase 3, real reads: getMessages returns the whole thread oldest first", async () => {
  const thread = await getMessages(service, organizationId, ids.failedReply);
  assert.deepEqual(thread.map((m) => m.status), ["received", "failed"]);
});
