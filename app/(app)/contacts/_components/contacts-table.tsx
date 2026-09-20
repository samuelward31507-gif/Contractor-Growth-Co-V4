import Link from "next/link";
import { ChevronRight, Search, Phone, Mail, Building2 } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import type { Contact } from "@/lib/contacts/queries";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px_20px]";

function secondaryLine(contact: Contact): string {
  return [contact.phone, contact.email].filter(Boolean).join(" · ") || "No details yet";
}

/** Icon-led detail cell - phone and email now read as distinct, scannable facts rather than one plain-text string joined by a middot. */
function ContactDetails({ contact }: { contact: Contact }) {
  if (!contact.phone && !contact.email) {
    return <span className="text-sm text-slate-400">No details yet</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {contact.phone ? (
        <span className="flex items-center gap-1.5 truncate text-sm text-slate-600">
          <Phone className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
          {contact.phone}
        </span>
      ) : null}
      {contact.email ? (
        <span className="flex items-center gap-1.5 truncate text-sm text-slate-600">
          <Mail className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
          {contact.email}
        </span>
      ) : null}
    </span>
  );
}

export function ContactsTable({ contacts, query }: { contacts: Contact[]; query: string }) {
  if (contacts.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title={`No contacts match "${query}"`}
        description="Try a different name, phone number, email, or company."
      />
    );
  }

  return (
    <div>
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} gap-6 border-b border-slate-200 px-2 pb-3`}>
          <span className="text-xs text-slate-400">Contact</span>
          <span className="text-xs text-slate-400">Details</span>
          <span className="text-xs text-slate-400">Created</span>
          <span />
        </div>
        <div className="divide-y divide-slate-100">
          {contacts.map((contact) => (
            <Link
              key={contact.id}
              href={`/contacts/${contact.id}`}
              className={`group grid ${ROW_GRID} items-center gap-6 rounded-md px-2 py-3.5 transition-colors hover:bg-slate-50`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                  {contactInitials(contact)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {contactDisplayName(contact)}
                  </span>
                  {contact.company_name ? (
                    <span className="flex items-center gap-1 truncate text-xs text-slate-500">
                      <Building2 className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
                      {contact.company_name}
                    </span>
                  ) : null}
                </span>
              </span>
              <ContactDetails contact={contact} />
              <span className="text-xs tabular-nums text-slate-400">{formatContactDate(contact.created_at)}</span>
              <ChevronRight
                className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500"
                aria-hidden
              />
            </Link>
          ))}
        </div>
      </div>

      <ul className="divide-y divide-slate-100 lg:hidden">
        {contacts.map((contact) => (
          <li key={contact.id}>
            <Link href={`/contacts/${contact.id}`} className="flex items-center gap-3 px-2 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                {contactInitials(contact)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">
                  {contactDisplayName(contact)}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {contact.company_name || secondaryLine(contact)}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
