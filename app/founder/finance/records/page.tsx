import Link from "next/link";
import type { ReactNode } from "react";
import { Landmark, Receipt, Repeat, Wallet, HandCoins } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import { addMonthsKey } from "@/lib/founder/model";
import { formatDateKey, formatDateTime } from "@/lib/founder/format";
import { getFinanceEvents, getFinanceRecords } from "@/lib/founder/finance-queries";
import { EXPENSE_CATEGORY_LABELS, INCOME_KIND_LABELS, RECEIVED_VIA_LABELS, isActiveCost, latestCashBalances, monthLabel, type FinanceEvent } from "@/lib/founder/finance";
import { requireFounderPage, LoadFailed } from "../../_components/page-parts";
import { FinanceTabs, Money, SourceTag } from "../_components/finance-parts";
import { CashBalanceDialogButton, EndRecurringCostButton, ExpenseDialogButton, IncomeDialogButton, MarkPaidButton, RecordRecurringPaymentButton, RecurringCostDialogButton, VoidRecordButton } from "../_components/finance-forms";

/**
 * Founder finance records: expenses, recurring costs, income received
 * outside Stripe and cash balances - each with its audited change history.
 * Records are never deleted: a mistake is corrected (with a reason) or
 * voided (with a reason), and both stay visible.
 */

const TABS = [
  { key: "expenses", label: "Expenses" },
  { key: "recurring", label: "Recurring costs" },
  { key: "income", label: "Income outside Stripe" },
  { key: "cash", label: "Cash balances" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const ACTION_LABELS: Record<FinanceEvent["action"], string> = { created: "Recorded", corrected: "Corrected", paid: "Marked paid", ended: "Ended", voided: "Voided" };
const shortDate = (key: string) => formatDateKey(key, { month: "short", day: "numeric", year: "numeric" });

export default async function FounderFinanceRecordsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { supabase, userId, timeZone, todayKey, monthKey } = await requireFounderPage();
  const { tab: tabParam } = await searchParams;
  const raw = Array.isArray(tabParam) ? tabParam[0] : tabParam;
  const tab: Tab = TABS.some((t) => t.key === raw) ? (raw as Tab) : "expenses";
  const [records, events] = await Promise.all([getFinanceRecords(supabase, userId), getFinanceEvents(supabase, userId)]);

  const header = <PageHeader eyebrow="Founder" title="Finance records" description="Your own entries. Corrections and voids keep the original, with a reason, in each record's history." action={<FinanceTabs active="records" />} />;

  if (!records.ok) {
    return (
      <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
        {header}
        {records.notEnabled ? <EmptyState icon={Landmark} title="Founder finance isn't enabled on this database" description="The finance migration (founder_finance.sql) hasn't been applied here." /> : <LoadFailed what="Your financial records" />}
      </div>
    );
  }

  const { expenses, recurringCosts, income, cashBalances } = records.data;
  const history = (id: string) => (events.ok ? events.data.filter((e) => e.entityId === id) : null);
  const counts: Record<Tab, number> = {
    expenses: expenses.filter((e) => !e.voidedAt).length,
    recurring: recurringCosts.filter((c) => !c.voidedAt).length,
    income: income.filter((r) => !r.voidedAt).length,
    cash: cashBalances.filter((b) => !b.voidedAt).length,
  };
  const lastMonth = addMonthsKey(monthKey, -1);

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      {header}
      <nav aria-label="Record type" className={segmentedTrackClass}>
        {TABS.map((t) => (
          <Link key={t.key} href={`/founder/finance/records?tab=${t.key}`} aria-current={t.key === tab ? "page" : undefined} className={segmentedItemClass(t.key === tab)}>
            {t.label}
            <span className="ml-1.5 tabular-nums text-ink-4">{counts[t.key]}</span>
          </Link>
        ))}
      </nav>
      {!events.ok ? <p className="text-xs text-ink-3">Change history couldn&rsquo;t be loaded right now. The records below are current.</p> : null}

      {tab === "expenses" ? (
        <RecordList
          title="Expenses"
          description="Counted on the date paid. Unpaid bills wait here until you mark them paid."
          action={<ExpenseDialogButton todayKey={todayKey} />}
          empty={<EmptyState icon={Receipt} title="No expenses yet" description="Record what the business pays for - software, contractors, Stripe fees - with the date it was paid." />}
          live={expenses.filter((e) => !e.voidedAt).map((e) => {
            const overdue = !e.paidOn && e.dueOn != null && e.dueOn < todayKey;
            const cost = e.recurringCostId ? recurringCosts.find((c) => c.id === e.recurringCostId) : null;
            return (
              <Row
                key={e.id}
                title={e.vendor}
                amount={<Money value={e.amount} currency={e.currency} />}
                meta={[EXPENSE_CATEGORY_LABELS[e.category], `Dated ${shortDate(e.incurredOn)}`, e.coversMonth ? `${cost?.cadence === "annual" ? "Annual" : "Recurring"} · covers ${monthLabel(e.coversMonth)}` : null, e.description]}
                badges={e.paidOn ? <Badge tone="success">Paid {shortDate(e.paidOn)}</Badge> : overdue ? <Badge tone="danger">Overdue · due {shortDate(e.dueOn!)}</Badge> : <Badge tone="warning">{e.dueOn ? `Unpaid · due ${shortDate(e.dueOn)}` : "Unpaid"}</Badge>}
                actions={
                  <>
                    {!e.paidOn ? <MarkPaidButton expense={e} todayKey={todayKey} /> : null}
                    <ExpenseDialogButton todayKey={todayKey} expense={e} />
                    <VoidRecordButton entity="expense" id={e.id} label={`${e.vendor} expense`} />
                  </>
                }
                history={history(e.id)}
                timeZone={timeZone}
              />
            );
          })}
          voided={expenses.filter((e) => e.voidedAt).map((e) => (
            <VoidedRow key={e.id} title={e.vendor} amount={<Money value={e.amount} currency={e.currency} />} reason={e.voidReason} history={history(e.id)} timeZone={timeZone} />
          ))}
        />
      ) : null}

      {tab === "recurring" ? (
        <RecordList
          title="Recurring costs"
          description="Commitments, not payments. Record each month's actual payment against the cost. A price change ends the cost and starts a new one."
          action={<RecurringCostDialogButton todayKey={todayKey} />}
          empty={<EmptyState icon={Repeat} title="No recurring costs yet" description="Add subscriptions and retainers so missing payments and true burn are visible." />}
          live={recurringCosts.filter((c) => !c.voidedAt).map((c) => {
            const payments = expenses.filter((e) => !e.voidedAt && e.recurringCostId === c.id && e.coversMonth).map((e) => e.coversMonth as string).sort();
            const last = payments.at(-1);
            const status = isActiveCost(c, todayKey) ? <Badge tone="success">Active</Badge> : c.startOn > todayKey ? <Badge tone="info">Starts {shortDate(c.startOn)}</Badge> : <Badge tone="neutral">Ended {shortDate(c.endOn!)}</Badge>;
            return (
              <Row
                key={c.id}
                title={c.vendor}
                amount={
                  <>
                    <Money value={c.amount} currency={c.currency} />
                    <span className="text-xs font-normal text-ink-3"> / {c.cadence === "monthly" ? "month" : "year"}</span>
                  </>
                }
                meta={[EXPENSE_CATEGORY_LABELS[c.category], `Since ${shortDate(c.startOn)}`, last ? `Last payment recorded for ${monthLabel(last)}` : "No payment recorded yet", c.description]}
                badges={status}
                actions={
                  <>
                    <RecordRecurringPaymentButton cost={c} todayKey={todayKey} defaultMonth={c.cadence === "monthly" && !payments.includes(lastMonth) && c.startOn <= lastMonth ? lastMonth : monthKey} />
                    <RecurringCostDialogButton todayKey={todayKey} cost={c} />
                    {!c.endOn ? <EndRecurringCostButton cost={c} todayKey={todayKey} /> : null}
                    <VoidRecordButton entity="recurring_cost" id={c.id} label={`${c.vendor} recurring cost`} />
                  </>
                }
                history={history(c.id)}
                timeZone={timeZone}
              />
            );
          })}
          voided={recurringCosts.filter((c) => c.voidedAt).map((c) => (
            <VoidedRow key={c.id} title={c.vendor} amount={<Money value={c.amount} currency={c.currency} />} reason={c.voidReason} history={history(c.id)} timeZone={timeZone} />
          ))}
        />
      ) : null}

      {tab === "income" ? (
        <RecordList
          title="Income received outside Stripe"
          description="Bank transfers, checks and cash only - kept apart from Stripe revenue and never counted in it. Stripe payments are recorded automatically."
          action={<IncomeDialogButton todayKey={todayKey} />}
          empty={<EmptyState icon={HandCoins} title="No manual income recorded" description="If a client pays by bank transfer or check, record it here so the net cash result is complete." />}
          live={income.filter((r) => !r.voidedAt).map((r) => (
            <Row
              key={r.id}
              title={r.payer}
              amount={<Money value={r.amount} currency={r.currency} />}
              meta={[INCOME_KIND_LABELS[r.kind], `Received ${shortDate(r.receivedOn)}`, RECEIVED_VIA_LABELS[r.receivedVia], r.reference ? `Ref ${r.reference}` : null, r.description]}
              badges={<SourceTag>Manual · not Stripe</SourceTag>}
              actions={
                <>
                  <IncomeDialogButton todayKey={todayKey} receipt={r} />
                  <VoidRecordButton entity="income" id={r.id} label={`${r.payer} income`} />
                </>
              }
              history={history(r.id)}
              timeZone={timeZone}
            />
          ))}
          voided={income.filter((r) => r.voidedAt).map((r) => (
            <VoidedRow key={r.id} title={r.payer} amount={<Money value={r.amount} currency={r.currency} />} reason={r.voidReason} history={history(r.id)} timeZone={timeZone} />
          ))}
        />
      ) : null}

      {tab === "cash" ? (
        <RecordList
          title="Cash balances"
          description="What each account statement showed on a date. Balances are never edited: record the correct balance, then void the wrong one."
          action={<CashBalanceDialogButton todayKey={todayKey} />}
          empty={<EmptyState icon={Wallet} title="No cash balances yet" description="Record each bank account's statement balance. Runway needs a balance younger than 35 days." />}
          live={(() => {
            const latestIds = new Set(latestCashBalances(cashBalances, todayKey).map((a) => a.id));
            const latest = latestCashBalances(cashBalances, todayKey);
            return cashBalances
              .filter((b) => !b.voidedAt)
              .map((b) => {
                const current = latestIds.has(b.id) ? latest.find((a) => a.id === b.id) : null;
                return (
                  <Row
                    key={b.id}
                    title={b.accountLabel}
                    amount={<Money value={b.balance} currency={b.currency} />}
                    meta={[`As of ${shortDate(b.asOf)}`, b.note]}
                    badges={current ? current.stale ? <Badge tone="warning">Latest · stale ({current.ageDays} days)</Badge> : <Badge tone="success">Latest</Badge> : <Badge tone="neutral">Earlier</Badge>}
                    actions={
                      <>
                        {current ? <CashBalanceDialogButton todayKey={todayKey} account={b} label="New balance" /> : null}
                        <VoidRecordButton entity="cash_balance" id={b.id} label={`${b.accountLabel} balance`} />
                      </>
                    }
                    history={history(b.id)}
                    timeZone={timeZone}
                  />
                );
              });
          })()}
          voided={cashBalances.filter((b) => b.voidedAt).map((b) => (
            <VoidedRow key={b.id} title={b.accountLabel} amount={<Money value={b.balance} currency={b.currency} />} reason={b.voidReason} history={history(b.id)} timeZone={timeZone} />
          ))}
        />
      ) : null}
    </div>
  );
}

function RecordList({ title, description, action, empty, live, voided }: { title: string; description: string; action: ReactNode; empty: ReactNode; live: ReactNode[]; voided: ReactNode[] }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">{title}</h2>
          <p className="mt-0.5 max-w-3xl text-sm text-ink-3">{description}</p>
        </div>
        <div className="flex items-center gap-3">{action}</div>
      </div>
      {live.length ? <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">{live}</ul> : empty}
      {voided.length ? (
        <details className="rounded-lg border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-ink-3">Voided ({voided.length}) - kept for the record, never counted</summary>
          <ul className="divide-y divide-line border-t border-line">{voided}</ul>
        </details>
      ) : null}
    </section>
  );
}

function Row({ title, amount, meta, badges, actions, history, timeZone }: { title: string; amount: ReactNode; meta: (string | null)[]; badges: ReactNode; actions: ReactNode; history: FinanceEvent[] | null; timeZone: string }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            {title}
            {badges}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">{meta.filter(Boolean).join(" · ")}</p>
        </div>
        <p className="shrink-0 text-sm font-semibold text-ink">{amount}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {actions}
        <History events={history} timeZone={timeZone} />
      </div>
    </li>
  );
}

function VoidedRow({ title, amount, reason, history, timeZone }: { title: string; amount: ReactNode; reason: string | null; history: FinanceEvent[] | null; timeZone: string }) {
  return (
    <li className="px-4 py-3 text-ink-3">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-sm">
          <span className="line-through">{title}</span>
          <span className="block text-xs">Voided{reason ? `: ${reason}` : ""}</span>
        </p>
        <p className="shrink-0 text-sm line-through">{amount}</p>
      </div>
      <div className="mt-1">
        <History events={history} timeZone={timeZone} />
      </div>
    </li>
  );
}

/** The record's append-only history: what happened, when, and why (for corrections and voids). */
function History({ events, timeZone }: { events: FinanceEvent[] | null; timeZone: string }) {
  if (!events || events.length === 0) return null;
  return (
    <details className="text-xs text-ink-3">
      <summary className="cursor-pointer select-none rounded-md px-2 py-1 hover:bg-hover">History ({events.length})</summary>
      <ol className="mt-1.5 space-y-1 border-l border-line pl-3">
        {events.map((e) => (
          <li key={e.id}>
            <span className="font-medium text-ink-2">{ACTION_LABELS[e.action]}</span> · {formatDateTime(e.occurredAt, timeZone)}
            {e.reason ? <span className="block text-ink-3">&ldquo;{e.reason}&rdquo;</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
