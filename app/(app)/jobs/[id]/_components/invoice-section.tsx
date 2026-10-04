import Link from "next/link";
import { Receipt } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { detailLabelClass, detailValueClass } from "@/lib/ui/typography";
import { formatContactDate } from "@/lib/contacts/format";
import { deriveInvoiceState, formatInvoiceNumber, formatMoney } from "@/lib/invoices/domain";
import type { Invoice } from "@/lib/invoices/queries";
import type { Job } from "@/lib/jobs/queries";
import { INVOICE_STATUS_ICON, INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE } from "../../../invoices/_components/status";
import { CreateInvoiceButton } from "./create-invoice-dialog";

/**
 * Phase 1B-3: the job's billing state, read straight from the database
 * (one live invoice per job, enforced by invoices_one_live_per_job). Shows
 * the invoice when one exists, otherwise the one action that creates a
 * draft. Amounts here are invoiced/paid figures, never called revenue.
 */
export function InvoiceSection({ job, invoice, today }: { job: Job; invoice: Invoice | null; today: string }) {
  if (!invoice) {
    return (
      <SectionCard title="Invoice" description="Nothing has been billed for this job yet.">
        <EmptyState
          icon={Receipt}
          title={job.status === "cancelled" ? "Cancelled jobs can't be invoiced." : "No invoice yet"}
          description={
            job.status === "cancelled"
              ? "Reopen the work as a new job if it goes ahead after all."
              : job.amount != null
                ? `Create a draft prefilled with the contracted amount of ${formatMoney(job.amount)}.`
                : "Create a draft and enter the total. You can also set it as the job's contracted amount."
          }
          action={job.status !== "cancelled" ? <CreateInvoiceButton job={{ id: job.id, title: job.title, amount: job.amount, status: job.status }} /> : undefined}
        />
      </SectionCard>
    );
  }

  const state = deriveInvoiceState({ status: invoice.status, total: invoice.total, amountPaid: invoice.amount_paid, dueDate: invoice.due_date }, today);
  const totalsDiffer = job.amount != null && Math.round(job.amount * 100) !== Math.round(invoice.total * 100);

  return (
    <SectionCard
      title="Invoice"
      action={
        <Link href={`/invoices/${invoice.id}`} className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
          View invoice
        </Link>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">{formatInvoiceNumber(invoice.number)}</span>
        <Badge tone={INVOICE_STATUS_TONE[invoice.status]} icon={INVOICE_STATUS_ICON[invoice.status]}>
          {INVOICE_STATUS_LABELS[invoice.status]}
        </Badge>
        {state.isOverdue ? <Badge tone="danger">Overdue · {state.daysOverdue} {state.daysOverdue === 1 ? "day" : "days"}</Badge> : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <div>
          <dt className={detailLabelClass}>Total</dt>
          <dd className={`${detailValueClass} tabular-nums`}>{formatMoney(invoice.total)}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Paid</dt>
          <dd className={`${detailValueClass} tabular-nums`}>{formatMoney(invoice.amount_paid)}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Balance due</dt>
          <dd className={`${detailValueClass} font-semibold tabular-nums`}>{invoice.status === "void" ? "—" : formatMoney(state.balanceDue)}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Due</dt>
          <dd className={detailValueClass}>{invoice.due_date ? formatContactDate(`${invoice.due_date}T12:00:00Z`) : "Set when issued"}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Created</dt>
          <dd className={detailValueClass}>{formatContactDate(invoice.created_at)}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Issued</dt>
          <dd className={detailValueClass}>{invoice.issued_at ? formatContactDate(invoice.issued_at) : "Not yet"}</dd>
        </div>
        {invoice.paid_at ? (
          <div>
            <dt className={detailLabelClass}>Paid in full</dt>
            <dd className={detailValueClass}>{formatContactDate(invoice.paid_at)}</dd>
          </div>
        ) : null}
        {invoice.voided_at ? (
          <div>
            <dt className={detailLabelClass}>Voided</dt>
            <dd className={detailValueClass}>{formatContactDate(invoice.voided_at)}</dd>
          </div>
        ) : null}
      </dl>

      {totalsDiffer ? (
        <p className="mt-4 rounded-lg border border-warning-border bg-warning-muted px-3.5 py-2.5 text-xs text-warning-text">
          This invoice total ({formatMoney(invoice.total)}) differs from the job&rsquo;s contracted amount ({formatMoney(job.amount as number)}). Invoice totals are frozen once issued; void it and create a new one to change the amount.
        </p>
      ) : null}
    </SectionCard>
  );
}
