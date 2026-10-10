import Link from "next/link";
import { Banknote, CircleDollarSign, Landmark, Receipt, Wallet } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { StatCard, StatGrid } from "@/lib/ui/stat-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { getFounderMrrEntries } from "@/lib/founder/queries";
import { addDaysKey, addMonthsKey, dayRange, mrrSnapshot } from "@/lib/founder/model";
import { getContractedMrr, getFinanceRecords, getStripeRevenueSummary, getUnrecoveredInvoices } from "@/lib/founder/finance-queries";
import { getCostEstimates, type CostEstimates } from "@/lib/founder/finance-estimates";
import {
  BURN_WINDOW_MONTHS,
  CASH_FRESHNESS_RULE,
  EXPENSE_CATEGORY_LABELS,
  FINANCE_PERIODS,
  FINANCE_PERIOD_LABELS,
  attentionItems,
  cashByCurrency,
  formatFinanceMoney,
  latestCashBalances,
  missingRecurringPayments,
  monthLabel,
  monthlyBurn,
  netCashResult,
  periodBounds,
  resolvePeriod,
  runway,
  stripeMajor,
  summarizeExpenses,
  summarizeManualIncome,
  summarizeRecurring,
  summarizeStripe,
  type CurrencyTotals,
} from "@/lib/founder/finance";
import { formatDateKey } from "@/lib/founder/format";
import { requireFounderPage, LoadFailed } from "../_components/page-parts";
import { Amounts, AttentionList, FinanceSection, FinanceTabs, Figure, Insufficient, Money, SourceTag } from "./_components/finance-parts";
import { CashBalanceDialogButton, ExpenseDialogButton } from "./_components/finance-forms";

/**
 * Founder finance overview: what the business collected, spent and holds,
 * and what needs attention - per currency, never converted, with every
 * source labelled. Contracted MRR, manual MRR and collected revenue are
 * separate metrics and are never added together. Reads only; every change
 * happens on the Records page through the audited database functions.
 */
export default async function FounderFinancePage({ searchParams }: { searchParams: Promise<{ period?: string | string[] }> }) {
  const { supabase, userId, timeZone, todayKey, monthKey } = await requireFounderPage();
  const { period: periodParam } = await searchParams;
  const period = resolvePeriod(periodParam);
  const bounds = periodBounds(period, todayKey);
  const from = dayRange(bounds.from, timeZone).start;
  const to = dayRange(bounds.to, timeZone).start;

  const agencyAdmin = await isAgencyAdmin(supabase).catch(() => false);
  const [records, stripeRows, unrecovered, contracted, mrr, estimates] = await Promise.all([
    getFinanceRecords(supabase, userId),
    getStripeRevenueSummary(supabase, from, to),
    getUnrecoveredInvoices(supabase),
    getContractedMrr(supabase),
    getFounderMrrEntries(supabase, userId),
    agencyAdmin ? getCostEstimates(supabase, createServiceRoleClient(), { from: from.toISOString(), to: to.toISOString() }) : Promise.resolve<CostEstimates>({ status: "no_agency_access" }),
  ]);

  const header = (
    <PageHeader
      eyebrow="Founder"
      title="Finance"
      description="What the business collected, spent and holds - per currency, from Stripe and your own records."
      action={<FinanceTabs active="overview" />}
    />
  );

  if (!records.ok) {
    return (
      <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
        {header}
        {records.notEnabled ? (
          <EmptyState icon={Landmark} title="Founder finance isn't enabled on this database" description="The finance migration (founder_finance.sql) hasn't been applied here." />
        ) : (
          <LoadFailed what="Your financial records" />
        )}
      </div>
    );
  }

  const { expenses, recurringCosts, income, cashBalances } = records.data;
  const stripe = stripeRows.ok ? summarizeStripe(stripeRows.data) : [];
  const manualIncome = summarizeManualIncome(income, bounds.from, bounds.to);
  const expenseSummary = summarizeExpenses(expenses, bounds.from, bounds.to, todayKey);
  const recurring = summarizeRecurring(recurringCosts, todayKey);
  // Without the Stripe figures a net result would silently leave out Stripe revenue - withhold it instead.
  const net = stripeRows.ok ? netCashResult(stripe, manualIncome.total, expenseSummary.paid) : null;
  const cashAccounts = latestCashBalances(cashBalances, todayKey);
  const cash = cashByCurrency(cashAccounts);
  const burn = monthlyBurn(expenses, todayKey);
  const runwayRows = runway(cash, burn.rows);
  const missing = missingRecurringPayments(recurringCosts, expenses, todayKey);
  const loadFailures = [!stripeRows.ok ? "Stripe revenue" : null, !unrecovered.ok ? "unpaid Stripe invoices" : null].filter(Boolean);
  const attention = attentionItems({
    todayKey,
    unrecovered: unrecovered.ok ? unrecovered.data : [],
    stripe,
    cashAccounts,
    hasAnyCashRecord: cashBalances.some((b) => !b.voidedAt),
    expenses,
    overdue: expenseSummary.overdue,
    missingPayments: missing,
    burnRows: burn.rows,
    burnWindowFrom: burn.window.from,
  });
  // A read that failed is said first, so an empty or short list never reads as "nothing wrong".
  if (loadFailures.length) attention.unshift({ id: "load-failed", tone: "danger", title: `Couldn't load ${loadFailures.join(" and ")}`, detail: "Revenue figures and this list may be incomplete. Refresh to try again." });
  const manualMrr = mrr.ok ? mrrSnapshot(mrr.data, monthKey) : null;

  const stripeCollected: CurrencyTotals = {};
  const stripeRecurring: CurrencyTotals = {};
  for (const row of stripe) {
    if (row.collected != null && row.collected > 0) stripeCollected[row.currency] = row.collected;
    if (row.recurring != null && row.recurring > 0) stripeRecurring[row.currency] = row.recurring;
  }
  const unverifiedStripe = stripe.filter((row) => !row.verified);
  const netTotals: CurrencyTotals = Object.fromEntries((net ?? []).filter((row) => row.net != null).map((row) => [row.currency, row.net as number]));
  const netExcluded = (net ?? []).filter((row) => row.net == null).map((row) => row.currency);
  const periodLabel = period === "this_month" ? `${monthLabel(monthKey)} to date` : `${formatDateKey(bounds.from, { month: "short", day: "numeric", year: "numeric" })} – ${formatDateKey(addDaysKey(bounds.to, -1), { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      {header}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Period" className={segmentedTrackClass}>
          {FINANCE_PERIODS.map((p) => (
            <Link key={p} href={p === "this_month" ? "/founder/finance" : `/founder/finance?period=${p}`} aria-current={p === period ? "page" : undefined} className={segmentedItemClass(p === period)}>
              {FINANCE_PERIOD_LABELS[p]}
            </Link>
          ))}
        </nav>
        <p className="text-xs text-ink-3">
          {periodLabel} · cash basis · each currency on its own
        </p>
      </div>

      {/* The four facts that matter most, per currency. */}
      <StatGrid columns={4}>
        <StatCard
          label="Collected via Stripe (gross)"
          value={<Amounts totals={stripeCollected} size="lg" empty={stripeRows.ok ? "None" : "Unavailable"} />}
          description={unverifiedStripe.length ? `Excludes ${unverifiedStripe.map((r) => r.currency).join(", ")} (format not verified)` : "Payments received, before fees and tax"}
          icon={CircleDollarSign}
          tone="success"
        />
        <StatCard label="Expenses paid" value={<Amounts totals={expenseSummary.paid} size="lg" empty="None recorded" />} description={`${expenseSummary.paidCount} payment${expenseSummary.paidCount === 1 ? "" : "s"} recorded in this period`} icon={Receipt} />
        <StatCard label="Net cash result" value={<Amounts totals={netTotals} size="lg" empty={net ? "Not available" : "Unavailable"} />} description={!net ? "Stripe revenue couldn't be loaded" : netExcluded.length ? `Excludes ${netExcluded.join(", ")} (format not verified)` : "Money in minus expenses paid"} icon={Banknote} tone={Object.values(netTotals).some((v) => v < 0) ? "danger" : "neutral"} />
        <StatCard
          label="Cash on hand"
          value={<Amounts totals={Object.fromEntries(cash.map((c) => [c.currency, c.total]))} size="lg" empty="Not recorded" />}
          description={cash.length ? (cash.some((c) => c.staleAccounts > 0) ? "Includes a stale balance" : `Latest statement balances`) : "Record a balance to see runway"}
          icon={Wallet}
          tone={cash.some((c) => c.staleAccounts > 0) || !cash.length ? "warning" : "neutral"}
        />
      </StatGrid>

      {attention.length ? (
        <FinanceSection id="attention" title="Needs attention" description="What could make these figures wrong or cost money, most urgent first.">
          <AttentionList items={attention} />
        </FinanceSection>
      ) : null}

      {/* Revenue ------------------------------------------------------------------------------ */}
      <FinanceSection id="revenue" title="Revenue" description="Four different measures, kept apart on purpose. Contracted and manual MRR are what's agreed or estimated; collected is money actually received.">
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Collected via Stripe" description="Gross: as paid, including any tax, before Stripe fees. Counted on the payment date.">
            {!stripeRows.ok ? (
              <LoadFailed what="Stripe revenue" />
            ) : stripe.length === 0 ? (
              <Insufficient>No Stripe payments, refunds or failed attempts were recorded in this period.</Insufficient>
            ) : (
              <div className="mt-3 space-y-4">
                {stripe.map((row) =>
                  row.verified ? (
                    <div key={row.currency} className="space-y-3">
                      <p className="text-xs font-semibold text-ink-3">{row.currency}</p>
                      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                        <Figure label="Collected" note={`${row.succeededPayments} payment${row.succeededPayments === 1 ? "" : "s"}`}>
                          <Money value={row.collected ?? 0} currency={row.currency} />
                        </Figure>
                        <Figure label="Recurring">
                          <Money value={row.recurring ?? 0} currency={row.currency} />
                        </Figure>
                        <Figure label="Setup fees">
                          <Money value={row.setup ?? 0} currency={row.currency} />
                        </Figure>
                        <Figure label="Refunded" note="Shown apart, never netted into a category">
                          <Money value={row.refunded ?? 0} currency={row.currency} />
                        </Figure>
                      </dl>
                      {(row.uncategorized ?? 0) > 0 ? (
                        <p className="text-xs text-ink-3">
                          <Money value={row.uncategorized ?? 0} currency={row.currency} /> of collected has no recurring/setup category from Stripe.
                        </p>
                      ) : null}
                      {row.failedAttempts > 0 ? (
                        <p className="text-xs text-warning-text">
                          {row.failedAttempts} failed attempt{row.failedAttempts === 1 ? "" : "s"} on {row.invoicesWithFailedAttempts} invoice{row.invoicesWithFailedAttempts === 1 ? "" : "s"} (<Money value={row.failedAttemptedAmount ?? 0} currency={row.currency} /> attempted). Attempts are not losses - see unpaid invoices below.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div key={row.currency} className="rounded-lg border border-line px-3 py-2.5 text-sm">
                      <p className="font-medium text-ink">{row.currency} · amount format not verified</p>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {row.succeededPayments} payment{row.succeededPayments === 1 ? "" : "s"}, {row.failedAttempts} failed attempt{row.failedAttempts === 1 ? "" : "s"}. Amounts aren&rsquo;t shown or totalled until this currency&rsquo;s Stripe format is verified.
                      </p>
                    </div>
                  ),
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Unpaid Stripe invoices" description="As of now: a payment failed and no successful payment has been recorded since. An invoice paid later is not counted.">
            {!unrecovered.ok ? (
              <LoadFailed what="Unpaid invoices" />
            ) : unrecovered.data.length === 0 ? (
              <p className="mt-3 text-sm text-ink-3">None. No Stripe invoice is unpaid after a failed payment.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {unrecovered.data.map((u) => {
                  const amount = stripeMajor(u.amountDueLatestAttempt, u.exponentStatus, u.exponent);
                  return (
                    <li key={u.currency} className="flex items-baseline justify-between gap-3 py-2.5">
                      <span className="text-sm text-ink">
                        {u.invoices} invoice{u.invoices === 1 ? "" : "s"} <span className="text-ink-3">· {u.currency}</span>
                        {u.latestFailureAt ? <span className="block text-xs text-ink-3">Latest failure {formatDateKey(u.latestFailureAt.slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}</span> : null}
                      </span>
                      <span className="text-sm font-semibold text-danger-text">{amount != null ? <Money value={amount} currency={u.currency} /> : "Format not verified"}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Income received outside Stripe" description="Bank transfers, checks and cash you recorded. Never part of the Stripe figures.">
            <div className="mt-3 flex items-start justify-between gap-4">
              <dl className="grid grid-cols-2 gap-4">
                <Figure label="Received this period" note={`${manualIncome.count} record${manualIncome.count === 1 ? "" : "s"}`}>
                  <Amounts totals={manualIncome.total} empty="None" />
                </Figure>
                <Figure label="Of which recurring fees">
                  <Amounts totals={manualIncome.recurring} empty="None" />
                </Figure>
              </dl>
              <SourceTag>Manual</SourceTag>
            </div>
          </SectionCard>

          <SectionCard title="Monthly recurring revenue" description="Agreed and estimated, not collected. The two measures below come from different places and are never added.">
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <Figure
                label="Contracted MRR · Agency client terms"
                note={
                  contracted.ok
                    ? contracted.data.length
                      ? `${contracted.data.reduce((n, c) => n + c.clientCount, 0)} live or ongoing client${contracted.data.reduce((n, c) => n + c.clientCount, 0) === 1 ? "" : "s"}. Setup fees agreed: ${contracted.data.map((c) => formatFinanceMoney(c.setupTotal, c.currency)).join(" · ")}`
                      : "No live or ongoing Agency clients."
                    : undefined
                }
              >
                {contracted.ok ? <Amounts totals={Object.fromEntries(contracted.data.map((c) => [c.currency, c.monthlyTotal]))} empty="None" /> : <span className="text-sm font-normal text-danger-text">Couldn&rsquo;t load</span>}
              </Figure>
              <Figure label="Manual MRR · your entries" note={<Link href="/founder/metrics" className="underline-offset-2 hover:underline">From MRR &amp; metrics (entered without a currency, shown as USD there)</Link>}>
                {!mrr.ok ? <span className="text-sm font-normal text-danger-text">Couldn&rsquo;t load</span> : manualMrr ? <Money value={manualMrr.mrr} currency="USD" /> : <span className="text-ink-3">No entries</span>}
              </Figure>
            </dl>
            <p className="mt-3 text-xs text-ink-3">Contracted MRR counts clients currently live or under ongoing management. Ended clients aren&rsquo;t tracked in this phase, so it can&rsquo;t show churn.</p>
          </SectionCard>
        </div>
      </FinanceSection>

      {/* Expenses & profitability ------------------------------------------------------------------ */}
      <FinanceSection
        id="expenses"
        title="Expenses and profitability"
        description="Expenses count on the date they're paid. Unpaid bills and recurring commitments are shown, but don't count until paid."
        action={<ExpenseDialogButton todayKey={todayKey} />}
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard title="Paid this period" className="lg:col-span-1">
            <dl className="mt-3 space-y-4">
              <Figure label="Expenses paid">
                <Amounts totals={expenseSummary.paid} empty="None recorded" />
              </Figure>
              <Figure label="Recorded but unpaid" note={`${expenseSummary.unpaidCount} bill${expenseSummary.unpaidCount === 1 ? "" : "s"}, any date`}>
                <Amounts totals={expenseSummary.unpaid} empty="None" />
              </Figure>
            </dl>
            {expenseSummary.byCategory.length ? (
              <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
                {expenseSummary.byCategory.slice(0, 5).map((c) => (
                  <li key={c.category} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-ink-2">{EXPENSE_CATEGORY_LABELS[c.category]}</span>
                    <span className="text-right text-ink">
                      <Amounts totals={c.totals} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </SectionCard>

          <SectionCard title="Recurring commitments" description="Active today. Monthly and annual costs are kept apart." className="lg:col-span-1">
            {recurring.activeCount === 0 ? (
              <div className="mt-3">
                <Insufficient>No recurring costs recorded. Add software, hosting and other subscriptions on the Records page.</Insufficient>
              </div>
            ) : (
              <dl className="mt-3 space-y-4">
                <Figure label="Every month">
                  <Amounts totals={recurring.monthly} empty="None" />
                </Figure>
                <Figure label="Every year">
                  <Amounts totals={recurring.annual} empty="None" />
                </Figure>
                <Figure label="Active costs">{recurring.activeCount}</Figure>
              </dl>
            )}
          </SectionCard>

          <SectionCard title="Net cash result" description="Stripe collected minus refunds, plus income received outside Stripe, minus expenses paid." className="lg:col-span-1">
            {!net ? (
              <div className="mt-3">
                <Insufficient>Not calculated: Stripe revenue couldn&rsquo;t be loaded, so the result would leave it out.</Insufficient>
              </div>
            ) : net.length === 0 ? (
              <div className="mt-3">
                <Insufficient>No money in or out was recorded in this period.</Insufficient>
              </div>
            ) : (
              <ul className="mt-3 space-y-3">
                {net.map((row) => (
                  <li key={row.currency} className="text-sm">
                    {row.net == null ? (
                      <p className="text-ink-3">
                        <span className="font-medium text-ink">{row.currency}</span> · not calculated: the Stripe amount format isn&rsquo;t verified.
                      </p>
                    ) : (
                      <>
                        <p className="flex items-baseline justify-between gap-3">
                          <span className="font-medium text-ink">{row.currency}</span>
                          <span className="text-base font-semibold">
                            <Money value={row.net} currency={row.currency} signed />
                          </span>
                        </p>
                        <p className="text-xs text-ink-3">
                          <Money value={row.inflow ?? 0} currency={row.currency} /> in · <Money value={row.outflow} currency={row.currency} /> out
                        </p>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-3">
              {expenses.some((e) => !e.voidedAt) ? "Gross: tax isn't separated, and Stripe fees count only if you recorded them as an expense." : "No expenses are recorded yet, so this overstates the result."}
            </p>
          </SectionCard>
        </div>

        <SectionCard title="AI and SMS usage costs (estimates)" description="Estimated from usage and published rates. Not expenses - the actual bills belong in expenses when you pay them.">
          <EstimatesPanel estimates={estimates} />
        </SectionCard>
      </FinanceSection>

      {/* Cash & runway ----------------------------------------------------------------------------- */}
      <FinanceSection id="cash" title="Cash and runway" description={`From balances you record. ${CASH_FRESHNESS_RULE}. Burn is the average of expenses paid in the last ${BURN_WINDOW_MONTHS} complete months.`} action={<CashBalanceDialogButton todayKey={todayKey} />}>
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Cash balances">
            {cashAccounts.length === 0 ? (
              <div className="mt-3">
                <Insufficient>No balance recorded. Enter what your bank statement shows to see runway.</Insufficient>
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {cashAccounts.map((a) => (
                  <li key={`${a.accountLabel}-${a.currency}`} className="flex items-baseline justify-between gap-3 py-2.5">
                    <span className="min-w-0 text-sm text-ink">
                      {a.accountLabel}
                      <span className={`block text-xs ${a.stale ? "font-medium text-warning-text" : "text-ink-3"}`}>
                        As of {formatDateKey(a.asOf, { month: "short", day: "numeric", year: "numeric" })} · {a.ageDays === 0 ? "today" : `${a.ageDays} day${a.ageDays === 1 ? "" : "s"} old`}
                        {a.stale ? " · stale" : ""}
                      </span>
                    </span>
                    <span className="text-sm font-semibold text-ink">
                      <Money value={a.balance} currency={a.currency} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Burn and runway" description={`Burn window: ${monthLabel(burn.window.from)} – ${monthLabel(addMonthsKey(burn.window.to, -1))}. Gross burn: revenue isn't netted against it.`}>
            {runwayRows.length === 0 ? (
              <div className="mt-3">
                <Insufficient>Runway needs a current cash balance and three complete months of paid expenses in the same currency.</Insufficient>
              </div>
            ) : (
              <ul className="mt-3 space-y-3">
                {runwayRows.map((row) => {
                  const b = burn.rows.find((x) => x.currency === row.currency);
                  return (
                    <li key={row.currency} className="rounded-lg border border-line px-3 py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium text-ink">{row.currency}</span>
                        <span className="text-base font-semibold text-ink">
                          {row.status === "ok" ? `${row.months.toFixed(1)} months` : row.status === "overdrawn" ? <span className="text-danger-text">No runway - overdrawn</span> : <span className="text-sm font-normal text-ink-3">Not calculated</span>}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {row.status === "ok" || row.status === "overdrawn" ? (
                          <>
                            <Money value={row.cash} currency={row.currency} /> cash ÷ <Money value={row.burn} currency={row.currency} /> monthly burn
                          </>
                        ) : (
                          row.reason
                        )}
                        {b && b.monthlyBurn == null && b.windowTotal > 0 ? (
                          <>
                            {" "}
                            (<Money value={b.windowTotal} currency={row.currency} /> paid in the window so far.)
                          </>
                        ) : null}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </div>
      </FinanceSection>

      <footer className="border-t border-line pt-4 text-xs leading-relaxed text-ink-3">
        <p>
          How these figures work: every amount stays in its own currency - nothing is converted or added across currencies. Stripe figures come from the payment webhook ledger as gross amounts; amounts in a currency whose Stripe format isn&rsquo;t verified are left out of totals. Income received outside Stripe, expenses, recurring costs and balances are your own records (manual, audited, never deleted). Contracted MRR comes from Agency client terms and shows totals only.
        </p>
        {stripeRows.ok && stripe.some((r) => r.lastRecordedAt) ? <p className="mt-1">Latest Stripe event in this period recorded {new Date(stripe.map((r) => r.lastRecordedAt ?? "").sort().at(-1) as string).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</p> : null}
      </footer>
    </div>
  );
}

function EstimatesPanel({ estimates }: { estimates: CostEstimates }) {
  if (estimates.status === "no_agency_access") {
    return (
      <div className="mt-3">
        <Insufficient>Not available for this account. AI and SMS costs are visible to Agency admins only, and there is no founder-level read for them yet.</Insufficient>
      </div>
    );
  }
  if (estimates.status === "error") return <div className="mt-3"><LoadFailed what="AI and SMS cost estimates" /></div>;
  const total = (list: { currency: string; amount: number }[]): CurrencyTotals => Object.fromEntries(list.map((x) => [x.currency, x.amount]));
  return (
    <>
      <dl className="mt-3 grid gap-4 sm:grid-cols-2">
        <Figure label="AI usage (priced)" note={`${estimates.ai.unpriced} unpriced and ${estimates.ai.unknown} unknown interaction${estimates.ai.unknown === 1 ? "" : "s"} not included`}>
          <Amounts totals={total(estimates.ai.known)} empty="None priced" />
        </Figure>
        <Figure label="SMS (priced)" note={`${estimates.sms.unknown} message${estimates.sms.unknown === 1 ? "" : "s"} without a known price not included`}>
          <Amounts totals={total(estimates.sms.known)} empty="None priced" />
        </Figure>
      </dl>
      <p className="mt-3 text-xs text-ink-3">
        Agency-wide totals for this period{estimates.partial ? " - partial: some data couldn't be read" : ""}. Per-client detail is on <Link href="/agency/costs" className="underline-offset-2 hover:underline">Agency costs</Link>.
      </p>
    </>
  );
}
