import { Receipt, Wallet, Hourglass, AlertTriangle, FileWarning } from "lucide-react";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { formatMoney } from "@/lib/invoices/domain";
import type { InvoiceMoneySummary } from "@/lib/invoices/summary";

/**
 * Phase 1B-3: the five invoice/payment figures on Money. Only "Collected"
 * is money received (customer_payments); Invoiced and Outstanding are
 * amounts asked for; Not yet invoiced is contracted work never billed.
 */
export function InvoiceMoneySummaryCards({ summary }: { summary: InvoiceMoneySummary }) {
  const count = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;
  return (
    <StatGrid columns={5}>
      <StatCard label="Invoiced" value={formatMoney(summary.invoiced)} description={summary.invoicedCount > 0 ? `${count(summary.invoicedCount, "issued invoice", "issued invoices")}${summary.draftCount > 0 ? ` · ${count(summary.draftCount, "draft", "drafts")} not counted` : ""}` : "No invoices issued yet"} icon={Receipt} href="/money?browse=invoices" />
      <StatCard label="Collected" value={formatMoney(summary.collected)} description={summary.paymentCount > 0 ? `${count(summary.paymentCount, "payment", "payments")} received · the only figure that is money in hand` : "No payments recorded yet"} tone="success" icon={Wallet} href="/money?browse=invoices&status=paid" />
      <StatCard label="Outstanding" value={formatMoney(summary.outstanding)} description={summary.outstandingCount > 0 ? `${count(summary.outstandingCount, "invoice", "invoices")} awaiting payment` : "Nothing awaiting payment"} icon={Hourglass} href="/money?browse=invoices&status=sent" />
      <StatCard label="Overdue" value={formatMoney(summary.overdue)} description={summary.overdueCount > 0 ? `${count(summary.overdueCount, "invoice", "invoices")} past due` : "Nothing past due"} tone={summary.overdueCount > 0 ? "danger" : "neutral"} icon={AlertTriangle} href="/money?browse=invoices&status=overdue" />
      <StatCard
        label="Not yet invoiced"
        value={summary.notYetInvoicedCount > 0 ? formatMoney(summary.notYetInvoicedKnownValue) : "$0"}
        description={
          summary.notYetInvoicedCount > 0
            ? `${count(summary.notYetInvoicedCount, "completed job", "completed jobs")} without an invoice${summary.notYetInvoicedUnknownCount > 0 ? ` (${summary.notYetInvoicedUnknownCount} with no amount set)` : ""}`
            : "Every completed job is invoiced"
        }
        tone={summary.notYetInvoicedCount > 0 ? "warning" : "neutral"}
        icon={FileWarning}
        href="/money?browse=jobs&status=completed"
      />
    </StatGrid>
  );
}
