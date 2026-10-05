// P0 A3: applies lead_sms_intake_unique.sql to an in-memory Postgres (PGlite)
// twice (idempotency), proves it refuses exactly a second unqualified
// sms_inbound lead for the same contact and nothing else, then rolls back.
// Never touches a real database.
//   cd supabase/pending/scratch && node validate-lead-sms-intake-unique.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../lead_sms_intake_unique.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../lead_sms_intake_unique_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();

await db.exec(`
  create table public.leads (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    contact_id uuid,
    source text,
    status text not null default 'new',
    created_at timestamptz not null default now()
  );
`);
const ORG = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "33333333-3333-4333-8333-333333333333";
const insert = (contact, source, status = "new") => db.query("insert into public.leads (organization_id, contact_id, source, status) values ($1, $2, $3, $4) returning id", [ORG, contact, source, status]);
const isUniqueViolation = (error) => error?.code === "23505";

// Pre-existing data the index must accept: closed history, manual/other-source duplicates.
await insert(C1, "sms_inbound", "lost");
await insert(C1, "sms_inbound", "won");
await insert(C1, "website", "new");
await insert(C1, "website", "new");

await db.exec(forward);
await db.exec(forward); // idempotent
console.log("ok  applies (twice) over closed sms history and duplicate manual/web leads");

await insert(C1, "sms_inbound", "new");
await assert.rejects(insert(C1, "sms_inbound", "new"), isUniqueViolation, "a second unqualified sms_inbound lead for the same contact");
console.log("ok  concurrent second sms_inbound 'new' lead for the same contact -> 23505");

await insert(C2, "sms_inbound", "new");
console.log("ok  a different contact is unaffected");
await insert(C1, "phone", "new");
await insert(C1, "manual", "new");
console.log("ok  other sources (manual, phone, web) are never constrained");

await db.exec(`update public.leads set status = 'lost' where contact_id = '${C1}' and source = 'sms_inbound' and status = 'new'`);
await insert(C1, "sms_inbound", "new");
console.log("ok  after the first closes, a new sms_inbound lead is allowed");

await db.exec(`update public.leads set status = 'contacted' where contact_id = '${C1}' and source = 'sms_inbound' and status = 'new'`);
await insert(C1, "sms_inbound", "new");
console.log("ok  once qualified (left 'new'), it no longer occupies the slot");

await insert(null, "sms_inbound", "new");
await insert(null, "sms_inbound", "new");
console.log("ok  contact-less rows are not constrained");

await db.exec(rollback);
assert.equal((await db.query("select count(*)::int n from pg_indexes where indexname = 'leads_one_new_sms_intake_per_contact'")).rows[0].n, 0);
await insert(C2, "sms_inbound", "new");
console.log("ok  rollback removes the index");
console.log("PASS lead_sms_intake_unique");
