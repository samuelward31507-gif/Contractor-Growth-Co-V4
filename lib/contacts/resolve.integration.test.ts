/**
 * Integration tests for resolveOrCreateContact() - against an isolated test
 * organization on the real Supabase project (this codebase's established
 * pattern - see outbound-gate.integration.test.ts). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/contacts/resolve.integration.test.ts
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

let organizationId: string;
let otherOrgId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Contact Resolve Test Org" }).select("id").single();
  const { data: other } = await service.from("organizations").insert({ name: "Contact Resolve Test Org - Other" }).select("id").single();
  organizationId = org!.id;
  otherOrgId = other!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("creates a new contact when nothing matches", async () => {
  const result = await resolveOrCreateContact(service, { organizationId, phone: "5551110001", firstName: "New" });
  assert.equal(result.outcome, "created");
  if (result.outcome === "created") {
    assert.equal(result.contact.phone, "5551110001");
  }
});

test("an existing normalized phone is matched, not duplicated, even with different raw formatting", async () => {
  const first = await resolveOrCreateContact(service, { organizationId, phone: "555-111-0002" });
  assert.equal(first.outcome, "created");

  const second = await resolveOrCreateContact(service, { organizationId, phone: "(555) 111-0002" });
  assert.equal(second.outcome, "matched");
  if (first.outcome === "created" && second.outcome === "matched") {
    assert.equal(second.contact.id, first.contact.id);
  }

  const { count } = await service.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("phone_normalized", "+15551110002");
  assert.equal(count, 1, "only one row for this normalized phone must exist");
});

test("an existing normalized email is matched, not duplicated, regardless of casing/whitespace", async () => {
  const first = await resolveOrCreateContact(service, { organizationId, email: "dedup-test@example.com" });
  assert.equal(first.outcome, "created");

  const second = await resolveOrCreateContact(service, { organizationId, email: "  Dedup-Test@Example.COM  " });
  assert.equal(second.outcome, "matched");
  if (first.outcome === "created" && second.outcome === "matched") {
    assert.equal(second.contact.id, first.contact.id);
  }
});

test("phone and email both matching the SAME existing contact is a clean match", async () => {
  const first = await resolveOrCreateContact(service, { organizationId, phone: "5551110003", email: "same-contact@example.com" });
  assert.equal(first.outcome, "created");

  const second = await resolveOrCreateContact(service, { organizationId, phone: "5551110003", email: "same-contact@example.com" });
  assert.equal(second.outcome, "matched");
  if (first.outcome === "created" && second.outcome === "matched") {
    assert.equal(second.contact.id, first.contact.id);
  }
});

test("phone matches one contact and email matches a DIFFERENT contact - a conflict, never auto-merged", async () => {
  const contactA = await resolveOrCreateContact(service, { organizationId, phone: "5551110004" });
  const contactB = await resolveOrCreateContact(service, { organizationId, email: "conflict-b@example.com" });
  assert.equal(contactA.outcome, "created");
  assert.equal(contactB.outcome, "created");

  const result = await resolveOrCreateContact(service, { organizationId, phone: "5551110004", email: "conflict-b@example.com" });
  assert.equal(result.outcome, "conflict");
  if (result.outcome === "conflict" && contactA.outcome === "created" && contactB.outcome === "created") {
    assert.equal(result.phoneMatch.id, contactA.contact.id);
    assert.equal(result.emailMatch.id, contactB.contact.id);
  }

  const { count } = await service.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("phone_normalized", "+15551110004");
  assert.equal(count, 1, "a conflict must never create a third contact or merge the two existing ones");
});

test("an ambiguous (unnormalizable) phone is never used for matching - two contacts with the same ambiguous raw phone stay separate", async () => {
  const first = await resolveOrCreateContact(service, { organizationId, phone: "1234567", firstName: "Ambiguous One" });
  const second = await resolveOrCreateContact(service, { organizationId, phone: "1234567", firstName: "Ambiguous Two" });
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "created");
  if (first.outcome === "created" && second.outcome === "created") {
    assert.notEqual(first.contact.id, second.contact.id, "an ambiguous phone must never be treated as an exact identity match");
  }
});

test("cross-org isolation: the same phone number in a different organization resolves to a different contact", async () => {
  const inOrgA = await resolveOrCreateContact(service, { organizationId, phone: "5551110005" });
  const inOrgB = await resolveOrCreateContact(service, { organizationId: otherOrgId, phone: "5551110005" });
  assert.equal(inOrgA.outcome, "created");
  assert.equal(inOrgB.outcome, "created");
  if (inOrgA.outcome === "created" && inOrgB.outcome === "created") {
    assert.notEqual(inOrgA.contact.id, inOrgB.contact.id);
  }
});

test("a merged (archived) contact's old identity does not block a genuinely new contact from reusing it", async () => {
  const { data: archived } = await service
    .from("contacts")
    .insert({ organization_id: organizationId, phone: "5551110006", phone_normalized: "+15551110006", merged_into_id: null })
    .select("id")
    .single();
  // Soft-merge it into some other row directly (bypassing the RPC here -
  // this test only needs the merged_into_id/active-index interaction, not
  // the merge RPC itself, which has its own dedicated test file).
  const { data: survivor } = await service.from("contacts").insert({ organization_id: organizationId, phone: "5551110007" }).select("id").single();
  await service.from("contacts").update({ merged_into_id: survivor!.id, merged_at: new Date().toISOString() }).eq("id", archived!.id);

  const result = await resolveOrCreateContact(service, { organizationId, phone: "5551110006", firstName: "Reused Number" });
  assert.equal(result.outcome, "created", "the archived contact must be excluded from matching, so this is a genuinely new contact");
  if (result.outcome === "created") {
    assert.notEqual(result.contact.id, archived!.id);
  }
});

test("concurrent resolution of the same new normalized phone never creates two contacts (race safety)", async () => {
  const phone = "5551110008";
  const results = await Promise.all([
    resolveOrCreateContact(service, { organizationId, phone }),
    resolveOrCreateContact(service, { organizationId, phone }),
    resolveOrCreateContact(service, { organizationId, phone }),
    resolveOrCreateContact(service, { organizationId, phone }),
    resolveOrCreateContact(service, { organizationId, phone }),
  ]);

  for (const result of results) {
    assert.notEqual(result.outcome, "error", `race must never surface as an error: ${JSON.stringify(result)}`);
  }

  const contactIds = new Set(
    results.map((r) => (r.outcome === "created" || r.outcome === "matched" ? r.contact.id : null)).filter((id): id is string => Boolean(id)),
  );
  assert.equal(contactIds.size, 1, "exactly one contact must exist for this identity, no matter how many concurrent callers raced for it");

  const { count } = await service.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("phone_normalized", "+15551110008");
  assert.equal(count, 1);
});
