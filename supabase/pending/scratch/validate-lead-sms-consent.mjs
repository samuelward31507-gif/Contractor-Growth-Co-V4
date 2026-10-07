// Final Batch 2: applies lead_sms_consent.sql to an in-memory Postgres
// (PGlite) twice (idempotency), proves existing rows stay null, only the
// three states are accepted, and the rollback removes it cleanly. Never
// touches a real database.
//   cd supabase/pending/scratch && node validate-lead-sms-consent.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../lead_sms_consent.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../lead_sms_consent_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();

await db.exec(`
  create table public.leads (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    contact_id uuid,
    source text,
    status text not null default 'new'
  );
`);
const ORG = "11111111-1111-4111-8111-111111111111";
await db.query("insert into public.leads (organization_id, source) values ($1, 'manual'), ($1, 'sms_inbound'), ($1, 'website')", [ORG]);

await db.exec(forward);
await db.exec(forward); // idempotent
const existing = await db.query("select count(*)::int as n from public.leads where sms_consent is not null");
assert.equal(existing.rows[0].n, 0);
console.log("ok  applies (twice); every existing lead stays null (no retroactive non-consent)");

for (const value of ["granted", "declined", "not_provided"]) {
  await db.query("insert into public.leads (organization_id, source, sms_consent) values ($1, 'website', $2)", [ORG, value]);
}
await db.query("insert into public.leads (organization_id, source) values ($1, 'manual')", [ORG]);
const defaulted = await db.query("select sms_consent from public.leads order by ctid desc limit 1");
assert.equal(defaulted.rows[0].sms_consent, null);
console.log("ok  accepts granted / declined / not_provided; a new row without it is null");

for (const bad of ["yes", "opted_out", ""]) {
  await assert.rejects(db.query("insert into public.leads (organization_id, source, sms_consent) values ($1, 'website', $2)", [ORG, bad]), (error) => error?.code === "23514", bad);
}
console.log("ok  rejects any other value (check constraint)");

await db.exec(rollback);
await db.exec(rollback); // idempotent
const column = await db.query("select count(*)::int as n from information_schema.columns where table_name = 'leads' and column_name = 'sms_consent'");
assert.equal(column.rows[0].n, 0);
const rows = await db.query("select count(*)::int as n from public.leads");
assert.equal(rows.rows[0].n, 7);
console.log("ok  rollback (twice) drops the column and constraint; no rows lost");
