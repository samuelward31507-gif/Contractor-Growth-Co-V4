/**
 * Phase 2E: Collected by lead source against real, disposable TEST fixtures -
 * real invoices and payments through the ledger's own triggers (which copy
 * job_id onto every payment), so each payment is attributed through
 * customer_payments.job_id → jobs.lead_id → leads.source exactly as in
 * Production. Covers named, Unknown source and No lead linked buckets,
 * several payments on one job, several jobs for one lead, a reversal, Denver
 * month boundaries (including payments at exactly local midnight), organization isolation, reconciliation with the
 * snapshot's Collected, and a 1,250-payment organization read across pages
 * by both the cash and the billing ledger reads.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/cash-attribution.integration.test.ts
 *
 * Cleanup: customer_payments is append-only by trigger (DELETE is refused,
 * including through the organization cascade), so these fixtures cannot be
 * removed through the API. after() prints the fixture organization ids;
 * remove them on TEST only, one organization at a time, in a single
 * transaction with `set local session_replication_role = replica`, deleting
 * by that organization_id. Every fixture organization is named
 * "Phase 2E Cash Attribution Test Org …".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("Phase 2E cash attribution fixtures run against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getCashAttribution, withCollected }: typeof import("./cash-attribution") = require(path.join(REPO_ROOT, "lib/bi/cash-attribution.ts"));
const { getRevenueAttribution }: typeof import("./revenue-attribution") = require(path.join(REPO_ROOT, "lib/bi/revenue-attribution.ts"));
const { getBillingRowsResult, computeBillingMetrics }: typeof import("./billing") = require(path.join(REPO_ROOT, "lib/bi/billing.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));
const { resolveDateRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/bi/queries.ts"));

const service = createServiceRoleClient();
const DENVER = "America/Denver";
let orgA: string;
let orgB: string;
let orgPaged: string;

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await service.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data!.id as string;
}

let phone = 0;
async function seed(orgId: string) {
  const contactId = await insert("contacts", { organization_id: orgId, phone: `+1555555${String(8300 + phone++)}` });
  const lead = (source: string | null) => insert("leads", { organization_id: orgId, contact_id: contactId, source, status: "won", temperature: "warm", created_at: "2026-08-01T15:00:00Z" });
  const job = (leadId: string | null) => insert("jobs", { organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Job", status: "completed", amount: 5000, created_at: "2026-08-02T15:00:00Z", completed_at: "2026-08-03T15:00:00Z" });
  /** A real issued invoice: inserted as a draft (the trigger forces it), then sent. */
  const invoice = async (jobId: string, total: number) => {
    const id = await insert("invoices", { organization_id: orgId, job_id: jobId, title: "Invoice", subtotal: total, total });
    const { error } = await service.from("invoices").update({ status: "sent" }).eq("id", id);
    if (error) throw new Error(`issue invoice: ${error.message}`);
    return id;
  };
  const payment = (invoiceId: string, amount: number, receivedAt: string, reverses?: string) =>
    insert("customer_payments", { organization_id: orgId, invoice_id: invoiceId, amount, method: "check", received_at: receivedAt, reverses_payment_id: reverses ?? null });
  return { lead, job, invoice, payment };
}

// "Last month" seen from Oct 15 in Denver: Sep 1 00:00 MDT (06:00Z) to Oct 1 00:00 MDT (06:00Z).
const NOW = new Date("2026-10-15T18:00:00Z");
const SEP = () => resolveDateRange("previousMonth", NOW, DENVER);

before(async () => {
  orgA = await insert("organizations", { name: "Phase 2E Cash Attribution Test Org A", timezone: DENVER });
  orgB = await insert("organizations", { name: "Phase 2E Cash Attribution Test Org B", timezone: DENVER });
  orgPaged = await insert("organizations", { name: "Phase 2E Cash Attribution Test Org (paged)", timezone: DENVER });
  const a = await seed(orgA);

  // Google lead with two jobs; the first job paid twice in September (a later payment on a second invoice too).
  const google = await a.lead("Google");
  const googleJob1 = await a.job(google);
  const googleJob2 = await a.job(google);
  const inv1 = await a.invoice(googleJob1, 1000);
  await a.payment(inv1, 300, "2026-09-01T06:30:00Z"); // Sep 1, 00:30 MDT - inside
  const reversed = await a.payment(inv1, 200, "2026-09-10T15:00:00Z");
  await a.payment(inv1, -200, "2026-09-11T15:00:00Z", reversed); // reversal - net 0
  await a.payment(inv1, 150.25, "2026-10-01T05:30:00Z"); // Sep 30, 23:30 MDT - inside, though Oct 1 in UTC
  const inv2 = await a.invoice(googleJob2, 500);
  await a.payment(inv2, 400, "2026-09-20T15:00:00Z");

  // " Google " groups with Google (trimmed); Referral paid only in October - outside.
  const googleSpaced = await a.lead(" Google ");
  await a.payment(await a.invoice(await a.job(googleSpaced), 100), 99.75, "2026-09-05T15:00:00Z");
  const referral = await a.lead("Referral");
  await a.payment(await a.invoice(await a.job(referral), 800), 800, "2026-10-01T06:30:00Z"); // Oct 1, 00:30 MDT - outside
  // Aug 31, 23:30 MDT - outside.
  await a.payment(await a.invoice(await a.job(referral), 50), 50, "2026-09-01T05:30:00Z");

  // Exactly Sep 1, 00:00 MDT (06:00Z) - inside; exactly Oct 1, 00:00 MDT - the next period.
  const yelp = await a.lead("Yelp");
  await a.payment(await a.invoice(await a.job(yelp), 25), 25, "2026-09-01T06:00:00Z");
  await a.payment(await a.invoice(await a.job(yelp), 40), 40, "2026-10-01T06:00:00Z");

  // Blank source → Unknown source; a job with no lead → No lead linked.
  await a.payment(await a.invoice(await a.job(await a.lead("   ")), 75), 75, "2026-09-15T15:00:00Z");
  await a.payment(await a.invoice(await a.job(null), 640), 640, "2026-09-16T15:00:00Z");

  // Organization B - same source, same month, never counted for A.
  const b = await seed(orgB);
  await b.payment(await b.invoice(await b.job(await b.lead("Google")), 9999), 9999, "2026-09-10T15:00:00Z");

  // 1,250 one-dollar September payments on one job - more than one page for every read.
  const p = await seed(orgPaged);
  const pagedInvoice = await p.invoice(await p.job(await p.lead("Yard sign")), 1250);
  const rows = Array.from({ length: 1250 }, (_, i) => ({ organization_id: orgPaged, invoice_id: pagedInvoice, amount: 1, method: "cash", received_at: `2026-09-${String(2 + (i % 27)).padStart(2, "0")}T15:00:00Z` }));
  const { error } = await service.from("customer_payments").insert(rows);
  if (error) throw new Error(`paged payments: ${error.message}`);
});

after(() => {
  // See the header: the append-only ledger keeps these on TEST until removed with the TEST-only transaction.
  console.log(`PHASE2E_FIXTURE_ORGS=${[orgA, orgB, orgPaged].filter(Boolean).join(",")}`);
});

test("last month in Denver: each payment attributed through job → lead → source; Unknown source and No lead linked kept; reversal netted; boundaries by Denver calendar", async () => {
  const cash = await getCashAttribution(service, orgA, SEP());
  assert.equal(cash.failed, false);
  assert.deepEqual(Object.fromEntries(cash.collectedByKey), { "source:Google": 950, "source:Yelp": 25, unknown: 75, unlinked: 640 });
  assert.equal(cash.total, 1690);
});

test("Revenue by source: Collected sits beside the existing figures and its total equals the snapshot's Collected for the same period", async () => {
  const range = SEP();
  const [attribution, cash, snapshot] = await Promise.all([
    getRevenueAttribution(service, orgA, range),
    getCashAttribution(service, orgA, range),
    getBusinessMetricsSnapshot(service, orgA, "previousMonth", { timeZone: DENVER, now: NOW }),
  ]);
  const table = withCollected(attribution, cash);
  assert.deepEqual(
    table.rows.map((row) => [row.label, row.collected]),
    [
      ["Google", 950],
      ["Yelp", 25],
      ["Unknown source", 75],
      ["No lead linked", 640],
    ],
  );
  assert.equal(snapshot.dataQuality.collectedRevenueUnavailable, false);
  assert.equal(table.totals.collected, snapshot.billingMetrics.collectedValue);
  assert.equal(snapshot.billingMetrics.collectedValue, 1690);
});

test("all time: every payment, including October's Referral and August's, still reconciling with the billing ledger", async () => {
  const range = resolveDateRange("allTime", NOW, DENVER);
  const [cash, ledger] = await Promise.all([getCashAttribution(service, orgA, range), getBillingRowsResult(service, orgA)]);
  assert.equal(cash.collectedByKey.get("source:Referral"), 850);
  assert.equal(cash.total, computeBillingMetrics({ invoices: ledger.invoices, payments: ledger.payments, range, today: "2026-10-15" }).collectedValue);
  assert.equal(cash.total, 2580);
});

test("organization isolation: B sees only its own payment, and A never sees B's", async () => {
  const b = await getCashAttribution(service, orgB, SEP());
  assert.deepEqual([...b.collectedByKey], [["source:Google", 9999]]);
  const a = await getCashAttribution(service, orgA, resolveDateRange("allTime", NOW, DENVER));
  assert.ok(![...a.collectedByKey.values()].includes(9999));
});

test("1,250 payments: the cash read and both billing ledger reads page past 1,000 rows and count every payment", async () => {
  const range = SEP();
  const [cash, ledger] = await Promise.all([getCashAttribution(service, orgPaged, range), getBillingRowsResult(service, orgPaged)]);
  assert.deepEqual([cash.failed, cash.total, cash.collectedByKey.get("source:Yard sign")], [false, 1250, 1250]);
  assert.deepEqual([ledger.failed, ledger.payments.length, ledger.invoices.length], [false, 1250, 1]);
  const billing = computeBillingMetrics({ invoices: ledger.invoices, payments: ledger.payments, range, today: "2026-10-15" });
  assert.deepEqual([billing.collectedValue, billing.paymentsReceived, billing.invoicesPaid], [1250, 1250, 1]);
});
