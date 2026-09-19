/**
 * Integration tests for Contact Deduplication V1's effect on the inbound
 * SMS path - mirrors app/api/webhooks/sms/inbound/route.ts's exact contact
 * resolution sequence (org lookup by sms_phone_number -> resolveOrCreateContact),
 * the same "call the real functions the route calls" technique already
 * established and validated this session (see the Inbound Customer Reply
 * production validation). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/contacts/inbound-sms-dedup.integration.test.ts
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

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { resolveOrCreateContact }: typeof import("./resolve") = require(path.join(REPO_ROOT, "lib/contacts/resolve.ts"));

const service = createServiceRoleClient();
const ORG_NUMBER = "+15555550199";

let organizationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Inbound SMS Dedup Test Org", sms_phone_number: ORG_NUMBER }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

/** Mirrors the inbound route's own org-then-contact resolution exactly. */
async function resolveInboundContact(fromRaw: string) {
  const { data: organization } = await service.from("organizations").select("id").eq("sms_phone_number", ORG_NUMBER).maybeSingle();
  assert.ok(organization, "the org must resolve by sms_phone_number first, exactly like the real route");
  const result = await resolveOrCreateContact(service, { organizationId: organization!.id, phone: fromRaw });
  return result;
}

test("a brand-new sender creates exactly one contact", async () => {
  const result = await resolveInboundContact("+15551230001");
  assert.equal(result.outcome, "created");
});

test("the same sender replying again reuses the same contact - no duplicate", async () => {
  const first = await resolveInboundContact("+15551230002");
  const second = await resolveInboundContact("+15551230002");
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "matched");
  if (first.outcome === "created" && second.outcome === "matched") {
    assert.equal(second.contact.id, first.contact.id);
  }
});

test("a contact manually entered with a differently-formatted version of the same number is reused by a later inbound message, not duplicated", async () => {
  // Simulates a contact created via the manual Contact form with US-style
  // formatting, then that same person texting in - Twilio's From is always
  // E.164, so this is exactly the formatting-mismatch scenario the audit
  // identified as the real production gap.
  const manuallyEntered = await resolveOrCreateContact(service, { organizationId, phone: "(555) 123-0003", firstName: "Manually Entered" });
  assert.equal(manuallyEntered.outcome, "created");

  const inbound = await resolveInboundContact("+15551230003");
  assert.equal(inbound.outcome, "matched");
  if (manuallyEntered.outcome === "created" && inbound.outcome === "matched") {
    assert.equal(inbound.contact.id, manuallyEntered.contact.id, "the differently-formatted manual entry and the E.164 inbound sender must resolve to the same contact");
  }
});

test("a replayed inbound message for the same contact does not create a second contact (idempotent at the contact-resolution layer)", async () => {
  const messageSid = `SM_DEDUP_TEST_${Date.now()}`;
  const resolveAndMaybeInsert = async () => {
    const { data: existingMessage } = await service.from("messages").select("id").eq("provider_message_id", messageSid).maybeSingle();
    if (existingMessage) return { outcome: "duplicate_message" as const };

    const contactResult = await resolveInboundContact("+15551230004");
    if (contactResult.outcome !== "matched" && contactResult.outcome !== "created") throw new Error("unexpected resolver outcome");

    const { data: conversation } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contactResult.contact.id, channel: "sms", status: "open" }).select("id").maybeSingle();
    if (conversation) {
      await service.from("messages").insert({ organization_id: organizationId, conversation_id: conversation.id, direction: "inbound", sender_type: "customer", body: "hi", status: "received", provider_message_id: messageSid });
    }
    return { outcome: "processed" as const, contactId: contactResult.contact.id };
  };

  const first = await resolveAndMaybeInsert();
  const replay = await resolveAndMaybeInsert();
  assert.equal(first.outcome, "processed");
  assert.equal(replay.outcome, "duplicate_message", "the route's own messages.provider_message_id idempotency check must short-circuit before contact resolution runs again");

  const { count } = await service.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("phone_normalized", "+15551230004");
  assert.equal(count, 1);
});
