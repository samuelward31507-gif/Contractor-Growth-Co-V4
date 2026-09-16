import Link from "next/link";
import { cardClass } from "@/lib/ui/card";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import type { Lead } from "@/lib/leads/queries";
import { StatusBadge, TemperatureBadge } from "./badges";

export function LeadsTable({ leads, hasActiveFilters }: { leads: Lead[]; hasActiveFilters: boolean }) {
  if (leads.length === 0) {
    return (
      <div className={`${cardClass} px-5 py-12 text-center`}>
        <p className="text-sm font-medium text-slate-900">No leads match your search.</p>
        <p className="mt-1 text-sm text-slate-500">
          {hasActiveFilters
            ? "Try a different search term or clear your filters."
            : "Try a different search term."}
        </p>
      </div>
    );
  }

  return (
    <div className={cardClass}>
      <table className="hidden w-full text-left text-sm lg:table">
        <thead>
          <tr className="border-b border-slate-100 text-xs font-medium uppercase tracking-wide text-slate-400">
            <th className="px-5 py-3 font-medium">Lead</th>
            <th className="px-5 py-3 font-medium">Service</th>
            <th className="px-5 py-3 font-medium">Source</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 font-medium">Temperature</th>
            <th className="px-5 py-3 font-medium">Value</th>
            <th className="px-5 py-3 font-medium">Created</th>
            <th className="px-5 py-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {leads.map((lead) => (
            <tr key={lead.id} className="transition-colors hover:bg-slate-50">
              <td className="px-5 py-3.5">
                <Link href={`/leads/${lead.id}`} className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                    {lead.contact ? contactInitials(lead.contact) : "?"}
                  </span>
                  <span>
                    <span className="block font-medium text-slate-900">
                      {lead.contact ? contactDisplayName(lead.contact) : "No contact"}
                    </span>
                    {lead.contact?.company_name ? (
                      <span className="block text-xs text-slate-500">{lead.contact.company_name}</span>
                    ) : null}
                  </span>
                </Link>
              </td>
              <td className="px-5 py-3.5 text-slate-600">{lead.service || "—"}</td>
              <td className="px-5 py-3.5 text-slate-600">{lead.source || "—"}</td>
              <td className="px-5 py-3.5">
                <StatusBadge status={lead.status} />
              </td>
              <td className="px-5 py-3.5">
                <TemperatureBadge temperature={lead.temperature} />
              </td>
              <td className="px-5 py-3.5 text-slate-600">
                {lead.estimated_value != null ? formatCurrency(lead.estimated_value) : "—"}
              </td>
              <td className="px-5 py-3.5 text-slate-500">{formatContactDate(lead.created_at)}</td>
              <td className="px-5 py-3.5 text-right">
                <Link
                  href={`/leads/${lead.id}`}
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-slate-100 lg:hidden">
        {leads.map((lead) => (
          <li key={lead.id}>
            <Link href={`/leads/${lead.id}`} className="flex items-start gap-3 px-4 py-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                {lead.contact ? contactInitials(lead.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {lead.contact ? contactDisplayName(lead.contact) : "No contact"}
                  </span>
                  <StatusBadge status={lead.status} />
                </span>
                <span className="mt-0.5 block truncate text-xs text-slate-500">
                  {lead.service || "General inquiry"}
                  {lead.estimated_value != null ? ` · ${formatCurrency(lead.estimated_value)}` : ""}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
