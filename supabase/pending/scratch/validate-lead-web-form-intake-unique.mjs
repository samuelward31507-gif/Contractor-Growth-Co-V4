// Validates lead_web_form_intake_unique.sql (+ rollback) on PGlite. Never
// connects to a real database.
//   cd supabase/pending/scratch && node validate-lead-web-form-intake-unique.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const db = new PGlite();
await db.exec(`
  create table public.leads (id uuid primary key default gen_random_uuid(), organization_id uuid not null, contact_id uuid, source text, status text not null default 'new');
  insert into public.leads (organization_id, contact_id, source, status) values
    ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'website', 'new'),
    ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'website', 'new');
`);
const ORG = "00000000-0000-4000-8000-000000000001", C = "00000000-0000-4000-8000-0000000000c1", C2 = "00000000-0000-4000-8000-0000000000c2";
const ins = (contact, channel, status = "new") => db.query("insert into public.leads (organization_id, contact_id, source, status, intake_channel) values ($1, $2, 'website', $3, $4)", [ORG, contact, status, channel]);
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

await db.exec(file("lead_web_form_intake_unique.sql"));
await db.exec(file("lead_web_form_intake_unique.sql"));
console.log("ok  applies twice over existing duplicate legacy rows (all null) without conflict");

await ins(C, "web_form");
assert.equal((await err(ins(C, "web_form")))?.code, "23505");
console.log("ok  a second 'new' web-form lead for the same contact is refused (23505)");
await ins(C2, "web_form");
await ins(C, null);
console.log("ok  other contacts and unmarked leads are unaffected");
await db.query("update public.leads set status = 'contacted' where contact_id = $1 and intake_channel = 'web_form'", [C]);
await ins(C, "web_form");
console.log("ok  once the first lead moves past 'new', a new web-form lead is allowed (same shape as the SMS index)");
assert.equal((await err(ins(C2, "other")))?.code, "23514");
console.log("ok  intake_channel only accepts 'web_form'");

await db.exec(file("lead_web_form_intake_unique_rollback.sql"));
await db.exec(file("lead_web_form_intake_unique_rollback.sql"));
const cols = (await db.query("select count(*)::int n from information_schema.columns where table_name = 'leads' and column_name = 'intake_channel'")).rows[0].n;
assert.equal(cols, 0);
console.log("ok  rollback removes index, constraint and column; idempotent");
console.log("all lead_web_form_intake_unique checks passed");
