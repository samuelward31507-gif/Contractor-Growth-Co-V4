/**
 * Founder finance boundaries, verified against source (no DOM or database
 * here): founder access is re-checked by every page and action; the UI never
 * writes a finance table directly; the Stripe and Agency figures come only
 * from the aggregate-only database functions; AI/SMS estimates stay apart
 * from expenses and expose no per-client rows; manual income never feeds the
 * Stripe figures; and the protected pending files are untouched by the UI.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/founder/finance/finance.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const PAGES = ["app/founder/finance/page.tsx", "app/founder/finance/records/page.tsx"];
const UI = [...PAGES, "app/founder/finance/_components/finance-forms.tsx", "app/founder/finance/_components/finance-parts.tsx"];
const actions = read("app/founder/finance/actions.ts");
const queries = read("lib/founder/finance-queries.ts");

test("both finance pages re-check founder access themselves, inside the founder layout", () => {
  for (const page of PAGES) assert.match(read(page), /await requireFounderPage\(\)/, page);
  assert.ok(fs.existsSync(path.join(process.cwd(), "app/founder/layout.tsx")), "inherits the founder layout's 404 for non-founders");
});

test("every exported finance action resolves founder access before anything else", () => {
  assert.match(actions, /^"use server";/);
  const exported = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.equal(exported.length, 11);
  for (const name of exported) {
    const body = actions.slice(actions.indexOf(`export async function ${name}(`));
    assert.match(body.slice(0, 260), /const ctx = await founder\(\);\s*if \(!ctx\) return NOT_AVAILABLE;/, name);
  }
});

test("no finance table is ever written from the app - every write is a founder_finance.sql function", () => {
  for (const file of ["app/founder/finance/actions.ts", ...UI, "lib/founder/finance-queries.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /\.(insert|update|upsert|delete)\(/, file);
  }
  const rpcs = [...actions.matchAll(/rpc\("(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(rpcs)], ["founder_correct_expense", "founder_correct_income", "founder_correct_recurring_cost", "founder_create_recurring_cost", "founder_end_recurring_cost", "founder_mark_expense_paid", "founder_record_cash_balance", "founder_record_expense", "founder_record_income"]);
  for (const fn of ["founder_void_expense", "founder_void_recurring_cost", "founder_void_income", "founder_void_cash_balance"]) assert.match(actions, new RegExp(`fn: "${fn}"`));
  assert.doesNotMatch(actions, /service|createServiceRoleClient/i, "actions use the founder's own session only");
});

test("Stripe and Agency figures come only from the aggregate-only functions - never the underlying tables", () => {
  for (const file of ["lib/founder/finance-queries.ts", ...UI, "app/founder/finance/actions.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /from\("(revenue_events|agency_clients|ai_cost_events|sms_cost_events|organizations)"\)/, file);
  }
  for (const fn of ["founder_stripe_revenue_summary", "founder_stripe_unrecovered_invoices", "founder_contracted_mrr"]) assert.match(queries, new RegExp(`rpc\\("${fn}"`));
  assert.doesNotMatch(queries, /founder_stripe_verified_exponent/, "the exponent helper isn't callable by clients and isn't called");
  // Owner-scoped reads of the founder's own records.
  for (const table of ["founder_expenses", "founder_recurring_costs", "founder_income_receipts", "founder_cash_balances", "founder_finance_events"]) {
    assert.match(queries, new RegExp(`from\\("${table}"\\)\\.select\\(\\w+\\)\\.eq\\("owner_id", ownerId\\)`), table);
  }
});

test("Stripe amounts convert only through the verified-exponent rule", () => {
  const model = read("lib/founder/finance.ts");
  assert.match(model, /if \(exponentStatus !== "verified" \|\| exponent == null/);
  assert.doesNotMatch(model, /\/ 100\b|\* 100\b(?!\))/, "no hard-coded cents conversion");
  const overview = read("app/founder/finance/page.tsx");
  assert.doesNotMatch(overview, /\/ 100\b/);
  assert.match(overview, /amount format not verified/);
});

test("manual income is never part of the Stripe figures; contracted, manual and collected MRR are never summed", () => {
  const model = read("lib/founder/finance.ts");
  const start = model.indexOf("export function summarizeStripe(");
  const summarize = model.slice(start, model.indexOf("\n}\n", start));
  assert.doesNotMatch(summarize, /IncomeReceipt|receipt|receivedOn|manual/i);
  const overview = read("app/founder/finance/page.tsx");
  assert.doesNotMatch(overview, /monthlyTotal\s*\+|manualMrr\.mrr\s*\+|\+\s*manualMrr/, "no arithmetic across the MRR measures");
  assert.match(overview, /Ended clients aren&rsquo;t tracked in this phase, so it can&rsquo;t show churn/);
  assert.match(overview, /Collected via Stripe \(gross\)/);
});

test("AI and SMS costs are estimates beside expenses, never inside them, and expose no per-client rows", () => {
  const estimates = read("lib/founder/finance-estimates.ts");
  assert.doesNotMatch(estimates, /clients/, "per-client results are dropped");
  assert.match(estimates, /getAgencyAiCosts\(sessionSupabase, serviceSupabase, range\)/, "reuses the agency read, which re-checks agency-admin access");
  const overview = read("app/founder/finance/page.tsx");
  assert.match(overview, /agencyAdmin \? getCostEstimates\(/, "only attempted for agency admins");
  const model = read("lib/founder/finance.ts");
  assert.doesNotMatch(model, /ai_cost|sms_cost|estimate/i, "no estimate reaches the expense, burn or net calculations");
});

test("the Finance nav entry sits in the founder group only", () => {
  const nav = read("lib/ui/operator-shell/nav.ts");
  const founder = nav.slice(nav.indexOf("export const FOUNDER_NAV_GROUP"));
  assert.match(founder, /\{ href: "\/founder\/finance", label: "Finance", icon: "Receipt" \}/);
  assert.doesNotMatch(nav.slice(0, nav.indexOf("export const FOUNDER_NAV_GROUP")), /\/founder\/finance/);
});

test("a failed source read is said, never shown as a smaller figure", () => {
  const overview = read("app/founder/finance/page.tsx");
  assert.match(overview, /const net = stripeRows\.ok \? netCashResult\(/, "no net cash result without the Stripe figures");
  assert.match(overview, /!stripeRows\.ok \? "Stripe revenue" : null, !unrecovered\.ok \? "unpaid Stripe invoices" : null/);
  assert.match(overview, /attention\.unshift\(\{ id: "load-failed", tone: "danger"/);
  assert.match(overview, /records\.notEnabled \?/);
  assert.match(read("app/founder/finance/records/page.tsx"), /records\.notEnabled \?/);
});

test("finance forms keep what was typed when a save is refused (no auto-resetting form actions)", () => {
  const forms = read("app/founder/finance/_components/finance-forms.tsx");
  assert.doesNotMatch(forms, /<form[^>]*\saction=/, "a form action resets every field when it finishes");
  assert.match(forms, /event\.preventDefault\(\);\s*if \(!isPending\) onSubmit\(new FormData\(event\.currentTarget\)\);/);
});
