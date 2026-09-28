// Disposable validation for supabase/pending/invoice_foundation_grants.sql
// and its rollback. Reproduces production's starting state (every table
// privilege granted to anon, authenticated and service_role on the two
// tables, the way this project's default privileges do), applies the revoke
// script, checks every privilege for every role with has_table_privilege,
// applies it again (idempotency), runs the rollback, and confirms the
// starting state is restored. Never opens a network connection.
// Run: node ./validate-grants.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pending = path.resolve(here, "..");
const forward = readFileSync(path.join(pending, "..", "migrations", "20260928163516_invoice_foundation_grants.sql"), "utf8");
const rollback = readFileSync(path.join(pending, "invoice_foundation_grants_rollback.sql"), "utf8");

const db = new PGlite();
let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}: ${detail}`);
  }
}

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const ROLES = ["anon", "authenticated", "service_role"];
const TABLES = ["invoices", "customer_payments"];

async function snapshot() {
  const out = {};
  for (const table of TABLES) {
    for (const role of ROLES) {
      const granted = [];
      for (const priv of PRIVS) {
        const r = await db.query("select has_table_privilege($1, $2, $3) ok", [role, `public.${table}`, priv]);
        if (r.rows[0].ok) granted.push(priv);
      }
      out[`${table}:${role}`] = granted.join(",");
    }
  }
  return out;
}

const ALL = PRIVS.join(",");

async function main() {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.invoices (id uuid primary key);
    create table public.customer_payments (id uuid primary key);
    grant all on table public.invoices, public.customer_payments to anon, authenticated, service_role;
  `);
  const before = await snapshot();
  check("starting state reproduces production (ALL for all three roles on both tables)", Object.values(before).every((v) => v === ALL), JSON.stringify(before));

  console.log("\n[1] apply revoke script");
  await db.exec(forward);
  const after = await snapshot();
  const expected = {
    "invoices:anon": "",
    "invoices:authenticated": "SELECT,INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER",
    "invoices:service_role": ALL,
    "customer_payments:anon": "",
    "customer_payments:authenticated": "SELECT,INSERT,TRUNCATE,REFERENCES,TRIGGER",
    "customer_payments:service_role": ALL,
  };
  for (const key of Object.keys(expected)) {
    check(`${key} -> ${expected[key] || "(none)"}`, after[key] === expected[key], `got ${after[key] || "(none)"}`);
  }

  console.log("\n[2] apply revoke script again (idempotent)");
  await db.exec(forward);
  check("second apply leaves privileges unchanged", JSON.stringify(await snapshot()) === JSON.stringify(after));

  console.log("\n[3] rollback restores the starting state");
  await db.exec(rollback);
  check("rollback restores ALL for all three roles", JSON.stringify(await snapshot()) === JSON.stringify(before));

  console.log("\n[4] re-apply after rollback");
  await db.exec(forward);
  check("re-apply reproduces the narrowed state", JSON.stringify(await snapshot()) === JSON.stringify(after));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("HARNESS ERROR:", error);
  process.exit(2);
});
