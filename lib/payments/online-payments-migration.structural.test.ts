/**
 * Phase 1C: structural checks of the PENDING migration
 * supabase/pending/online_payments.sql and its rollback - the same
 * source-text discipline lib/invoices/idempotency-migration.structural.test.ts
 * uses. The behavioral proof lives in
 * supabase/pending/scratch/validate-online-payments.mjs (a real Postgres via
 * PGlite); this file only pins the shape a reviewer must be able to trust
 * before the script is applied - above all, that no accounting rule is
 * replaced or relaxed. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/online-payments-migration.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const forward = read("supabase/pending/online_payments.sql");
const rollback = read("supabase/pending/online_payments_rollback.sql");
/** The executable statements only - header/inline comments are prose, not DDL. */
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, "");
const forwardSql = stripComments(forward);
const rollbackSql = stripComments(rollback);
const previous = read("supabase/migrations/20260928181837_payment_idempotency_and_invoice_opportunities.sql");
const captured = read("supabase/pending/reference/record_automation_incident_signal.captured.sql");
const capturedSignal = captured.slice(captured.indexOf("CREATE OR REPLACE FUNCTION public.record_automation_incident_signal"));

function extractImmutable(source: string): string {
  const start = source.indexOf("create or replace function public.customer_payments_immutable()");
  return source.slice(start, source.indexOf("$$;", start) + 3);
}

function extractSignal(source: string): string {
  const start = source.indexOf("CREATE OR REPLACE FUNCTION public.record_automation_incident_signal");
  return source.slice(start, source.indexOf("$function$", source.indexOf("AS $function$", start) + 13) + "$function$".length);
}

test("the migration is pending: it lives only in supabase/pending, never in supabase/migrations", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "supabase/pending/online_payments.sql")), true);
  const applied = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((name) => name.includes("online_payments"));
  assert.deepEqual(applied, []);
});

test("both scripts wrap themselves in one transaction", () => {
  for (const sql of [forwardSql, rollbackSql]) {
    assert.match(sql, /^\s*begin;/m);
    assert.match(sql.trimEnd(), /commit;$/);
  }
});

test("no accounting function is replaced: only customer_payments_immutable, record_automation_incident_signal and three new guard functions are created", () => {
  const created = (forwardSql.match(/create or replace function public\.(\w+)/gi) ?? []).map((statement) => statement.split(".")[1]);
  assert.deepEqual(created.sort(), [
    "customer_payments_immutable",
    "customer_payments_online_guard",
    "guard_organizations_stripe_connect",
    "invoices_payment_token_guard",
    "record_automation_incident_signal",
  ]);
  for (const untouched of ["customer_payments_guard_insert", "customer_payments_apply", "invoices_guard_insert", "invoices_guard_update", "invoices_guard_delete", "create_invoice_audit_event", "merge_contacts"]) {
    assert.doesNotMatch(forwardSql, new RegExp(`function public\\.${untouched}\\b`), `${untouched} must not be redefined`);
  }
});

test("the forward script never writes invoice money or status and never updates invoices directly (the token backfill is a column default)", () => {
  assert.doesNotMatch(forwardSql, /update public\.invoices/i);
  assert.doesNotMatch(forwardSql, /amount_paid\s*=|paid_at\s*=|trackpr\.applying_payment/i);
  assert.match(forward, /add column if not exists payment_token text not null default encode\(extensions\.gen_random_bytes\(24\), 'hex'\);/);
});

test("no RLS policy changes, and the only grant/revoke statements restate record_automation_incident_signal's existing privileges", () => {
  assert.doesNotMatch(forwardSql, /create policy|drop policy|alter policy|row level security/i);
  const privilegeStatements = forwardSql.match(/^\s*(grant|revoke)\b.*$/gim) ?? [];
  assert.equal(privilegeStatements.length, 3);
  for (const statement of privilegeStatements) assert.match(statement, /on function public\.record_automation_incident_signal\(uuid, text, text, text, text, text, text, uuid, jsonb\)/);
});

test("customer_payments_immutable gains exactly the three Stripe comparisons, and the rollback restores the previous body byte-for-byte", () => {
  const before = extractImmutable(previous);
  const after = extractImmutable(forward);
  const added =
    "     or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id\n" +
    "     or new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id\n" +
    "     or new.stripe_account_id is distinct from old.stripe_account_id\n";
  assert.ok(after.includes(added));
  assert.equal(after.replace(added, ""), before, "removing the three added lines reproduces the 20260928181837 body");
  assert.equal(extractImmutable(rollback), before, "the rollback restores the 20260928181837 body");
});

test("record_automation_incident_signal gains exactly the one category, and the rollback restores the captured body byte-for-byte", () => {
  const after = extractSignal(forward);
  assert.equal(after.replace("    'scheduled_automation_stale',\n    'online_payment_reconciliation'\n", "    'scheduled_automation_stale'\n") + "\n", capturedSignal);
  assert.equal(extractSignal(rollback) + "\n", capturedSignal);
  assert.match(captured, /md5 dfca7377dd707f2cd7814f87ae84a6bf/);
});

test("online payments are replay-proof and database-verified", () => {
  assert.match(forward, /create unique index if not exists customer_payments_stripe_checkout_session_unique\s+on public\.customer_payments \(stripe_checkout_session_id\)\s+where stripe_checkout_session_id is not null;/);
  assert.match(forward, /create unique index if not exists customer_payments_stripe_payment_intent_unique\s+on public\.customer_payments \(stripe_payment_intent_id\)\s+where stripe_payment_intent_id is not null;/);
  assert.match(forwardSql, /check \(coalesce\(/, "a NULL Stripe id must never pass customer_payments_stripe_fields");
  assert.match(forwardSql, /Online card payments can only be recorded by the Stripe webhook/);
  assert.match(forwardSql, /stripe_account_id does not match the organization''s connected Stripe account/);
  assert.match(forwardSql, /check \(method in \('cash', 'check', 'card_elsewhere', 'bank_transfer', 'other', 'card_online'\)\)/);
});

test("the rollback refuses while any Phase 1C data exists, then restores the narrower checks", () => {
  assert.match(rollback, /Refusing to roll back: card_online customer payments exist/);
  assert.match(rollback, /Refusing to roll back: online_payment_reconciliation incidents exist/);
  assert.match(rollback, /Refusing to roll back: organizations have a Stripe Connect account id/);
  assert.match(rollbackSql, /check \(method in \('cash', 'check', 'card_elsewhere', 'bank_transfer', 'other'\)\)/);
  const categoryCheck = rollbackSql.slice(rollbackSql.indexOf("add constraint automation_incidents_category_check"));
  assert.doesNotMatch(categoryCheck.slice(0, categoryCheck.indexOf(";")), /online_payment_reconciliation/);
});

test("the forward script is rerun-safe: every DDL statement is guarded", () => {
  assert.doesNotMatch(forwardSql, /add column (?!if not exists)/i);
  assert.doesNotMatch(forwardSql, /create (unique )?index (?!if not exists)/i);
  const triggers = forwardSql.match(/create trigger (\w+)/g) ?? [];
  for (const statement of triggers) {
    const name = statement.split(" ")[2];
    assert.match(forwardSql, new RegExp(`drop trigger if exists ${name} on`), `${name} is dropped before it is created`);
  }
  const constraints = forwardSql.match(/add constraint (\w+)/g) ?? [];
  for (const statement of constraints) {
    const name = statement.split(" ")[2];
    assert.match(forwardSql, new RegExp(`(conname = '${name}'|drop constraint if exists ${name})`), `${name} is guarded`);
  }
});
