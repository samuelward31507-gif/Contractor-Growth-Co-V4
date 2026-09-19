/**
 * Unit tests for findPotentialDuplicates()'s grouping/labeling logic,
 * against a hand-rolled mock Supabase client (matching lib/automation/
 * authorization.test.ts's own established pattern for exactly this class
 * of test). Deliberately NOT an integration test: since the Contact
 * Deduplication V1 migration adds a real database-level unique index on
 * (organization_id, phone_normalized)/(organization_id, email_normalized),
 * two simultaneously-active contacts sharing a normalized identity cannot
 * be constructed in the real database at all post-migration (confirmed
 * directly against production - see the feature's own audit) - which is
 * exactly the guarantee the feature provides. This file proves the
 * grouping/labeling logic itself is correct against a fixed, known input
 * shape, independent of whether real duplicate rows can exist. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/contacts/duplicates.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { findPotentialDuplicates }: typeof import("./duplicates") = require("./duplicates.ts");

function mockClient(rows: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            limit: async () => ({ data: rows }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function contact(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    first_name: `Contact${id}`,
    last_name: null,
    phone: null,
    email: null,
    company_name: null,
    notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    phone_normalized: null,
    email_normalized: null,
    ...overrides,
  };
}

test("two contacts sharing a normalized phone are grouped with reason 'phone'", async () => {
  const rows = [contact("a", { phone_normalized: "+15551234567" }), contact("b", { phone_normalized: "+15551234567" }), contact("c", { phone_normalized: "+15559999999" })];
  const groups = await findPotentialDuplicates(mockClient(rows), "org-1");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "phone");
  assert.deepEqual(groups[0].contacts.map((c) => c.id).sort(), ["a", "b"]);
});

test("two contacts sharing a normalized email are grouped with reason 'email'", async () => {
  const rows = [contact("a", { email_normalized: "same@example.com" }), contact("b", { email_normalized: "same@example.com" })];
  const groups = await findPotentialDuplicates(mockClient(rows), "org-1");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "email");
});

test("two contacts sharing BOTH normalized phone and email are grouped once, labeled 'phone_and_email'", async () => {
  const rows = [
    contact("a", { phone_normalized: "+15551234567", email_normalized: "same@example.com" }),
    contact("b", { phone_normalized: "+15551234567", email_normalized: "same@example.com" }),
  ];
  const groups = await findPotentialDuplicates(mockClient(rows), "org-1");
  assert.equal(groups.length, 1, "must not appear twice (once for phone, once for email)");
  assert.equal(groups[0].reason, "phone_and_email");
});

test("a contact with a unique phone and no email is never grouped", async () => {
  const rows = [contact("a", { phone_normalized: "+15551234567" }), contact("b", { phone_normalized: "+15559999999" })];
  const groups = await findPotentialDuplicates(mockClient(rows), "org-1");
  assert.equal(groups.length, 0);
});

test("three contacts sharing a normalized phone are grouped together as one group of three", async () => {
  const rows = [contact("a", { phone_normalized: "+15551234567" }), contact("b", { phone_normalized: "+15551234567" }), contact("c", { phone_normalized: "+15551234567" })];
  const groups = await findPotentialDuplicates(mockClient(rows), "org-1");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].contacts.length, 3);
});

test("null/missing normalized values are never grouped with each other", async () => {
  const rows = [contact("a"), contact("b"), contact("c")];
  const groups = await findPotentialDuplicates(mockClient(rows), "org-1");
  assert.equal(groups.length, 0);
});
