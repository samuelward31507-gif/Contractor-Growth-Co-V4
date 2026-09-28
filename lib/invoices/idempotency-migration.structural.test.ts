/**
 * Phase 1B-5: structural checks of the migration
 * supabase/migrations/20260928181837_payment_idempotency_and_invoice_opportunities.sql
 * (applied to production as ledger version 20260928181837) and its
 * rollback in supabase/pending/ - the same source-text discipline supabase/migrations/
 * opportunities-migration.test.ts's Part 1 uses. The behavioral proof lives
 * in supabase/pending/scratch/validate-payment-idempotency.mjs (49 checks
 * against a real Postgres via PGlite); this file only pins the shape a
 * reviewer must be able to trust before the script is applied. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/invoices/idempotency-migration.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const forward = read("supabase/migrations/20260928181837_payment_idempotency_and_invoice_opportunities.sql");
const rollback = read("supabase/pending/payment_idempotency_and_invoice_opportunities_rollback.sql");
/** The executable statements only - header/inline comments are prose, not DDL. */
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, "");
const forwardSql = stripComments(forward);
const rollbackSql = stripComments(rollback);
const foundation = read("supabase/migrations/20260928162500_invoice_foundation.sql");
const domain = read("lib/invoices/domain.ts");

const ALL_TYPES = [
  "qualified_lead_unbooked",
  "stale_estimate",
  "completed_appointment_no_estimate",
  "dormant_customer",
  "no_show",
  "completed_job_no_referral_request",
  "completed_job_no_review_request",
  "cancelled_appointment_no_rebooking",
  "uncontacted_lead",
  "accepted_estimate_no_job",
  "active_lead_signal",
  "pending_estimate",
  "completed_job_not_invoiced",
  "invoice_overdue",
];

test("the applied migration lives in supabase/migrations under its production ledger version, exactly once, and no copy remains in supabase/pending", () => {
  const matches = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((name) => name.includes("payment_idempotency"));
  assert.deepEqual(matches, ["20260928181837_payment_idempotency_and_invoice_opportunities.sql"]);
  assert.equal(fs.existsSync(path.join(ROOT, "supabase/pending/payment_idempotency_and_invoice_opportunities.sql")), false);
});

test("client_key is a nullable text column with a partial UNIQUE index on (organization_id, client_key) and a shape constraint matching the application's CLIENT_KEY_PATTERN", () => {
  assert.match(forward, /alter table public\.customer_payments\s+add column if not exists client_key text;/);
  assert.match(forward, /create unique index if not exists customer_payments_org_client_key_unique\s+on public\.customer_payments \(organization_id, client_key\)\s+where client_key is not null;/);
  assert.match(forward, /customer_payments_client_key_shape[\s\S]*?check \(client_key is null or \(length\(client_key\) between 8 and 128 and client_key ~ '\^\[A-Za-z0-9_-\]\+\$'\)\)/);
  assert.match(domain, /CLIENT_KEY_PATTERN = \/\^\[A-Za-z0-9_-\]\{8,128\}\$\//);
});

test("the ONLY function replaced is customer_payments_immutable, and its new body is the foundation body plus one client_key comparison", () => {
  const replaced = forward.match(/create or replace function public\.(\w+)/g) ?? [];
  assert.deepEqual(replaced, ["create or replace function public.customer_payments_immutable"]);
  assert.doesNotMatch(forwardSql, /create policy|drop policy|create trigger|drop trigger|\bgrant\b|\brevoke\b/i);

  const extract = (source: string) => source.slice(source.indexOf("create or replace function public.customer_payments_immutable()"), source.indexOf("$$;", source.indexOf("create or replace function public.customer_payments_immutable()")) + 3);
  const original = extract(foundation);
  const updated = extract(forward);
  assert.equal(updated.replace("     or new.client_key is distinct from old.client_key\n", ""), original, "removing the one added line reproduces the foundation body byte-for-byte");
  assert.equal(extract(rollback), original, "the rollback restores the foundation body byte-for-byte");
});

test("opportunities_type_check is re-created with every existing type plus the two new ones; source_entity_type is untouched", () => {
  assert.match(forward, /alter table public\.opportunities\s+drop constraint if exists opportunities_type_check;/);
  for (const type of ALL_TYPES) assert.match(forward, new RegExp(`'${type}'`));
  assert.doesNotMatch(forwardSql, /source_entity_type/);
});

test("the rollback refuses while keyed payments or new-type opportunities exist, then removes exactly what the forward script added", () => {
  assert.match(rollback, /Refusing to roll back: customer_payments rows carry a client_key/);
  assert.match(rollback, /Refusing to roll back: opportunities of the new types exist/);
  assert.match(rollback, /drop index if exists public\.customer_payments_org_client_key_unique;/);
  assert.match(rollback, /drop constraint if exists customer_payments_client_key_shape;/);
  assert.match(rollback, /drop column if exists client_key;/);
  const recreatedCheck = rollbackSql.slice(rollbackSql.indexOf("add constraint opportunities_type_check"));
  for (const type of ALL_TYPES.slice(0, 12)) assert.match(recreatedCheck, new RegExp(`'${type}'`));
  assert.doesNotMatch(recreatedCheck, /'completed_job_not_invoiced'|'invoice_overdue'/, "the re-created CHECK is the 12-type one; the new names appear only in the refusal guard");
});

test("the forward script is rerun-safe: every DDL statement is guarded", () => {
  assert.match(forward, /add column if not exists/);
  assert.match(forward, /create unique index if not exists/);
  assert.match(forward, /if not exists \(\s*select 1 from pg_constraint[\s\S]*?customer_payments_client_key_shape/);
  assert.match(forward, /drop constraint if exists opportunities_type_check/);
});
