import Link from "next/link";
import { ChevronRight, SearchX } from "lucide-react";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { formatInvoiceNumber, formatMoney, isOverdue } from "@/lib/invoices/domain";
import type { Invoice } from "@/lib/invoices/queries";
import { Badge, RAIL_TONE_CLASS } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { INVOICE_STATUS_ICON, INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE } from "./status";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_128px_104px_104px_104px_20px]";

/** The invoices list for Money's "Invoices" tab - the EstimatesTable shape (aligned grid on desktop, stacked rows on mobile). */
export function InvoicesTable({ invoices, hasActiveFilters, today }: { invoices: Invoice[]; hasActiveFilters: boolean; today: string }) {
  if (invoices.length === 0) {
    return (
      <div className="px-2">
        <EmptyState icon={SearchX} title="No invoices match your search." description={hasActiveFilters ? "Try a different search term or clear your filters." : "Try a different search term."} />
      </div>
    );
  }

  return (
    <div>
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} gap-6 border-b border-l-2 border-l-transparent border-slate-200 pl-3 pr-2 pb-3`}>
          <span className="text-xs text-slate-400">Invoice</span>
          <span className="text-xs text-slate-400">Status</span>
          <span className="text-right text-xs text-slate-400">Total</span>
          <span className="text-right text-xs text-slate-400">Balance</span>
          <span className="text-xs text-slate-400">Due</span>
          <span />
        </div>
        <div className="divide-y divide-slate-100">
          {invoices.map((invoice) => {
            const overdue = isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today);
            return (
              <Link
                key={invoice.id}
                href={`/invoices/${invoice.id}`}
                className={`group grid ${ROW_GRID} items-center gap-6 rounded-r-md border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${overdue ? RAIL_TONE_CLASS.danger : RAIL_TONE_CLASS[INVOICE_STATUS_TONE[invoice.status]]}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                    {invoice.contact ? contactInitials(invoice.contact) : "?"}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      <span className="text-slate-500">{formatInvoiceNumber(invoice.number)}</span> · {invoice.title}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {invoice.contact ? contactDisplayName(invoice.contact) : "No contact"}
                      {invoice.contact?.company_name ? ` · ${invoice.contact.company_name}` : ""}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Badge tone={INVOICE_STATUS_TONE[invoice.status]} icon={INVOICE_STATUS_ICON[invoice.status]}>
                    {INVOICE_STATUS_LABELS[invoice.status]}
                  </Badge>
                  {overdue ? <Badge tone="danger">Overdue</Badge> : null}
                </span>
                <span className="text-right text-sm font-medium tabular-nums text-slate-700">{formatMoney(invoice.total)}</span>
                <span className="text-right text-sm tabular-nums text-slate-700">{invoice.status === "void" ? "—" : formatMoney(invoice.balance_due)}</span>
                <span className="text-xs tabular-nums text-slate-400">{invoice.due_date ? formatContactDate(`${invoice.due_date}T12:00:00Z`) : "—"}</span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500" />
              </Link>
            );
          })}
        </div>
      </div>

      <ul className="divide-y divide-slate-100 lg:hidden">
        {invoices.map((invoice) => {
          const overdue = isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today);
          return (
            <li key={invoice.id}>
              <Link
                href={`/invoices/${invoice.id}`}
                className={`flex items-start gap-3 border-l-2 py-3.5 pl-3 pr-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${overdue ? RAIL_TONE_CLASS.danger : RAIL_TONE_CLASS[INVOICE_STATUS_TONE[invoice.status]]}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                  {invoice.contact ? contactInitials(invoice.contact) : "?"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">
                      {formatInvoiceNumber(invoice.number)} · {invoice.title}
                    </span>
                    <Badge tone={overdue ? "danger" : INVOICE_STATUS_TONE[invoice.status]} icon={INVOICE_STATUS_ICON[invoice.status]}>
                      {overdue ? "Overdue" : INVOICE_STATUS_LABELS[invoice.status]}
                    </Badge>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-slate-500">{invoice.contact ? contactDisplayName(invoice.contact) : "No contact"}</span>
                    <span className="shrink-0 text-xs font-medium tabular-nums text-slate-600">
                      {invoice.status === "void" ? formatMoney(invoice.total) : `${formatMoney(invoice.balance_due)} due`}
                    </span>
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
