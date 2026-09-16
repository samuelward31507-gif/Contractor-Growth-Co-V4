import Link from "next/link";
import { cardClass } from "@/lib/ui/card";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import type { Contact } from "@/lib/contacts/queries";
import { Icon } from "../../_components/icon";

export function ContactsTable({ contacts, query }: { contacts: Contact[]; query: string }) {
  if (contacts.length === 0) {
    return (
      <div className={`${cardClass} px-5 py-12 text-center`}>
        <p className="text-sm font-medium text-slate-900">No contacts match &quot;{query}&quot;</p>
        <p className="mt-1 text-sm text-slate-500">Try a different name, phone number, email, or company.</p>
      </div>
    );
  }

  return (
    <div className={cardClass}>
      <table className="hidden w-full text-left text-sm lg:table">
        <thead>
          <tr className="border-b border-slate-100 text-xs font-medium uppercase tracking-wide text-slate-400">
            <th className="px-5 py-3 font-medium">Contact</th>
            <th className="px-5 py-3 font-medium">Company</th>
            <th className="px-5 py-3 font-medium">Phone</th>
            <th className="px-5 py-3 font-medium">Email</th>
            <th className="px-5 py-3 font-medium">Created</th>
            <th className="px-5 py-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {contacts.map((contact) => (
            <tr key={contact.id} className="transition-colors hover:bg-slate-50">
              <td className="px-5 py-3.5">
                <Link href={`/contacts/${contact.id}`} className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                    {contactInitials(contact)}
                  </span>
                  <span className="font-medium text-slate-900">{contactDisplayName(contact)}</span>
                </Link>
              </td>
              <td className="px-5 py-3.5 text-slate-600">{contact.company_name || "—"}</td>
              <td className="px-5 py-3.5 text-slate-600">{contact.phone || "—"}</td>
              <td className="px-5 py-3.5 text-slate-600">{contact.email || "—"}</td>
              <td className="px-5 py-3.5 text-slate-500">{formatContactDate(contact.created_at)}</td>
              <td className="px-5 py-3.5 text-right">
                <Link
                  href={`/contacts/${contact.id}`}
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
        {contacts.map((contact) => (
          <li key={contact.id}>
            <Link href={`/contacts/${contact.id}`} className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                {contactInitials(contact)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">
                  {contactDisplayName(contact)}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {contact.company_name || contact.phone || contact.email || "No details yet"}
                </span>
              </span>
              <Icon name="arrow-left" className="h-4 w-4 shrink-0 rotate-180 text-slate-300" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
