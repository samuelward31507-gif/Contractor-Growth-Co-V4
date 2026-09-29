import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { getInvoiceWithContext } from "@/lib/invoices/queries";
import { formatInvoiceNumber, formatMoney } from "@/lib/invoices/domain";
import { contactDisplayName, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { successBannerClass } from "@/lib/ui/form";
import { INVOICE_STATUS_ICON, INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE } from "../_components/status";
import { InvoiceActions } from "./_components/invoice-actions";
import { PaymentHistory } from "./_components/payment-history";

/**
 * Phase 1B-3: the invoice record. Every money figure on this page is read
 * from the database (amount_paid maintained by the payment trigger,
 * balance_due generated); only "overdue" is derived here, from due_date and
 * today in the organization's timezone. Internal notes render for members
 * only - this page has no public counterpart.
 */
export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const context = await getInvoiceWithContext(supabase, membership.organizationId, id);

  if (!context) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Invoice not found</h1>
        <p className="text-sm text-slate-500">This invoice may have been deleted, or the link is incorrect.</p>
        <Link href="/money?browse=invoices" className="mt-2 text-sm font-medium text-slate-900 hover:underline">
          Back to Invoices
        </Link>
      </div>
    );
  }

  const { invoice, payments, state } = context;
  const label = formatInvoiceNumber(invoice.number);
  const customerName = invoice.contact ? contactDisplayName(invoice.contact) : "No contact";
  const dueLabel = invoice.due_date ? formatContactDate(`${invoice.due_date}T12:00:00Z`) : null;

  return (
    <div className="flex flex-1 flex-col">
      <DetailHeader
        eyebrow={`Invoice · ${label}`}
        backHref="/money?browse=invoices"
        backLabel="Back to Invoices"
        title={invoice.title}
        subtitle={customerName}
        badges={
          <>
            <Badge tone={INVOICE_STATUS_TONE[invoice.status]} icon={INVOICE_STATUS_ICON[invoice.status]}>
              {INVOICE_STATUS_LABELS[invoice.status]}
            </Badge>
            {state.isOverdue ? (
              <Badge tone="danger">
                Overdue · {state.daysOverdue} {state.daysOverdue === 1 ? "day" : "days"}
              </Badge>
            ) : null}
          </>
        }
        action={<InvoiceActions invoice={{ id: invoice.id, number: invoice.number, status: invoice.status, total: invoice.total, amountPaid: invoice.amount_paid, dueDate: invoice.due_date }} />}
        meta={
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <div>
              <p className="text-[12.5px] font-medium text-slate-500">{invoice.status === "paid" ? "Paid in full" : invoice.status === "void" ? "Voided" : "Balance due"}</p>
              <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-slate-900">{invoice.status === "void" ? "—" : formatMoney(invoice.status === "paid" ? invoice.total : state.balanceDue)}</p>
            </div>
            <div>
              <p className="text-[12.5px] font-medium text-slate-500">Total</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{formatMoney(invoice.total)}</p>
            </div>
            <div>
              <p className="text-[12.5px] font-medium text-slate-500">Paid</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{formatMoney(invoice.amount_paid)}</p>
            </div>
            <div>
              <p className="text-[12.5px] font-medium text-slate-500">Due</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{dueLabel ?? (invoice.status === "draft" ? "Set on issue" : "—")}</p>
            </div>
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        {invoice.status === "paid" && invoice.paid_at ? (
          <div className={successBannerClass}>
            <p className="font-medium">Paid in full</p>
            <p>Every dollar of this invoice was recorded as received by {formatContactDate(invoice.paid_at)}.</p>
          </div>
        ) : null}
        {invoice.status === "void" ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
            <p className="font-medium text-slate-900">Void{invoice.voided_at ? ` since ${formatContactDate(invoice.voided_at)}` : ""}</p>
            <p>{invoice.void_reason ? `Reason: ${invoice.void_reason}. ` : ""}This number is retired; the job can be invoiced again.</p>
          </div>
        ) : null}
        {invoice.status === "draft" ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
            <p className="font-medium text-slate-900">Draft</p>
            <p>The total can still change. Issue it to fix the amount and start recording payments.</p>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <SectionCard title="Invoice">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                <div>
                  <dt className={detailLabelClass}>Subtotal</dt>
                  <dd className={`${detailValueClass} tabular-nums`}>{formatMoney(invoice.subtotal)}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Tax</dt>
                  <dd className={`${detailValueClass} tabular-nums`}>{formatMoney(invoice.tax_amount)}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Total</dt>
                  <dd className={`${detailValueClass} font-semibold tabular-nums`}>{formatMoney(invoice.total)}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Amount paid</dt>
                  <dd className={`${detailValueClass} tabular-nums`}>{formatMoney(invoice.amount_paid)}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Balance due</dt>
                  <dd className={`${detailValueClass} font-semibold tabular-nums`}>{invoice.status === "void" ? "—" : formatMoney(state.balanceDue)}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Due date</dt>
                  <dd className={detailValueClass}>{dueLabel ?? "—"}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Created</dt>
                  <dd className={detailValueClass}>{formatContactDate(invoice.created_at)}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Issued</dt>
                  <dd className={detailValueClass}>{invoice.issued_at ? formatContactDate(invoice.issued_at) : "—"}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>{invoice.voided_at ? "Voided" : "Paid in full"}</dt>
                  <dd className={detailValueClass}>{invoice.voided_at ? formatContactDate(invoice.voided_at) : invoice.paid_at ? formatContactDate(invoice.paid_at) : "—"}</dd>
                </div>
              </dl>
              {invoice.notes ? (
                <div className="mt-4">
                  <dt className={detailLabelClass}>Internal notes</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{invoice.notes}</dd>
                </div>
              ) : null}
            </SectionCard>

            <PaymentHistory payments={payments} invoiceStatus={invoice.status} />

            {invoice.job ? (
              <SectionCard
                title="Job"
                action={
                  <Link href={`/jobs/${invoice.job.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                    View job
                  </Link>
                }
              >
                <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <div>
                    <dt className={detailLabelClass}>Title</dt>
                    <dd className={detailValueClass}>{invoice.job.title}</dd>
                  </div>
                  <div>
                    <dt className={detailLabelClass}>Job status</dt>
                    <dd className={detailValueClass}>{JOB_STATUS_LABELS[invoice.job.status]}</dd>
                  </div>
                  <div>
                    <dt className={detailLabelClass}>Contracted amount</dt>
                    <dd className={`${detailValueClass} tabular-nums`}>{invoice.job.amount != null ? formatMoney(invoice.job.amount) : "—"}</dd>
                  </div>
                </dl>
              </SectionCard>
            ) : null}

            {invoice.estimate ? (
              <SectionCard
                title="Estimate"
                action={
                  <Link href={`/estimates/${invoice.estimate.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                    View estimate
                  </Link>
                }
              >
                <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <div>
                    <dt className={detailLabelClass}>Title</dt>
                    <dd className={detailValueClass}>{invoice.estimate.title}</dd>
                  </div>
                  <div>
                    <dt className={detailLabelClass}>Estimate status</dt>
                    <dd className={detailValueClass}>{ESTIMATE_STATUS_LABELS[invoice.estimate.status]}</dd>
                  </div>
                  <div>
                    <dt className={detailLabelClass}>Quoted amount</dt>
                    <dd className={`${detailValueClass} tabular-nums`}>{invoice.estimate.amount != null ? formatMoney(invoice.estimate.amount) : "—"}</dd>
                  </div>
                </dl>
              </SectionCard>
            ) : null}
          </div>

          <div className="flex flex-col gap-6">
            {invoice.contact ? (
              <SectionCard
                title="Customer"
                action={
                  <Link href={`/people/${invoice.contact.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                    View contact
                  </Link>
                }
              >
                <dl className="space-y-3">
                  <div>
                    <dt className={detailLabelClass}>Name</dt>
                    <dd className={detailValueClass}>{customerName}</dd>
                  </div>
                  {invoice.contact.company_name ? (
                    <div>
                      <dt className={detailLabelClass}>Company</dt>
                      <dd className={detailValueClass}>{invoice.contact.company_name}</dd>
                    </div>
                  ) : null}
                  {invoice.contact.phone ? (
                    <div>
                      <dt className={detailLabelClass}>Phone</dt>
                      <dd className={detailValueClass}>{invoice.contact.phone}</dd>
                    </div>
                  ) : null}
                  {invoice.contact.email ? (
                    <div>
                      <dt className={detailLabelClass}>Email</dt>
                      <dd className={detailValueClass}>{invoice.contact.email}</dd>
                    </div>
                  ) : null}
                </dl>
              </SectionCard>
            ) : null}

            <Panel>
              <h2 className={subsectionTitleClass}>Details</h2>
              <dl className="mt-3 space-y-3">
                <div>
                  <dt className={detailLabelClass}>Invoice number</dt>
                  <dd className={detailValueClass}>{label}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Added</dt>
                  <dd className={detailValueClass}>{formatContactDate(invoice.created_at)}</dd>
                </div>
                {invoice.updated_at !== invoice.created_at ? (
                  <div>
                    <dt className={detailLabelClass}>Last updated</dt>
                    <dd className={detailValueClass}>{formatContactDate(invoice.updated_at)}</dd>
                  </div>
                ) : null}
              </dl>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
