import Link from "next/link";
import { ChevronRight, Search, Phone, Mail, Building2 } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import type { Contact } from "@/lib/contacts/queries";
import { CONTACT_LIFECYCLE_LABEL, CONTACT_LIFECYCLE_TONE, type ContactLifecycleStage } from "@/lib/customers/lifecycle-stage";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_136px_96px_20px]";

function secondaryLine(contact: Contact): string {
  return [contact.phone, contact.email].filter(Boolean).join(" · ") || "No details yet";
}

/** Icon-led detail cell - phone and email now read as distinct, scannable facts rather than one plain-text string joined by a middot. */
function ContactDetails({ contact }: { contact: Contact }) {
  if (!contact.phone && !contact.email) {
    return <span className="text-sm text-ink-3">No details yet</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {contact.phone ? (
        <span className="flex items-center gap-1.5 truncate text-sm text-ink-2">
          <Phone className="h-3 w-3 shrink-0 text-ink-3" aria-hidden />
          {contact.phone}
        </span>
      ) : null}
      {contact.email ? (
        <span className="flex items-center gap-1.5 truncate text-sm text-ink-2">
          <Mail className="h-3 w-3 shrink-0 text-ink-3" aria-hidden />
          {contact.email}
        </span>
      ) : null}
    </span>
  );
}

export function ContactsTable({
  contacts,
  query,
  lifecycleByContactId,
}: {
  contacts: Contact[];
  query: string;
  /** Usability audit fix (#2): one derived lifecycle stage per contact - see lib/customers/lifecycle-stage.ts. Optional so this component still type-checks anywhere it might be reused without the signal wired up; falls back to "new" (the same neutral tone a contact with no activity yet would resolve to anyway). */
  lifecycleByContactId?: Map<string, ContactLifecycleStage>;
}) {
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
        <div className={`grid ${ROW_GRID} gap-6 border-b border-line px-2 pb-3`}>
          <span className="text-xs text-ink-3">Contact</span>
          <span className="text-xs text-ink-3">Details</span>
          <span className="text-xs text-ink-3">Status</span>
          <span className="text-xs text-ink-3">Created</span>
          <span />
        </div>
        <div className="divide-y divide-line">
          {contacts.map((contact) => {
            const lifecycle = lifecycleByContactId?.get(contact.id) ?? "new";
            return (
              <Link
                key={contact.id}
                href={`/contacts/${contact.id}`}
                className={`group grid ${ROW_GRID} items-center gap-6 rounded-md px-2 py-3.5 transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
                    {contactInitials(contact)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {contactDisplayName(contact)}
                    </span>
                    {contact.company_name ? (
                      <span className="flex items-center gap-1 truncate text-xs text-ink-3">
                        <Building2 className="h-3 w-3 shrink-0 text-ink-3" aria-hidden />
                        {contact.company_name}
                      </span>
                    ) : null}
                  </span>
                </span>
                <ContactDetails contact={contact} />
                <span>
                  <Badge tone={CONTACT_LIFECYCLE_TONE[lifecycle]} className={lifecycle === "lost" ? "opacity-70" : undefined}>
                    {CONTACT_LIFECYCLE_LABEL[lifecycle]}
                  </Badge>
                </span>
                <span className="text-xs tabular-nums text-ink-3">{formatContactDate(contact.created_at)}</span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 justify-self-end text-ink-4 transition-colors group-hover:text-ink-3"
                  aria-hidden
                />
              </Link>
            );
          })}
        </div>
      </div>

      <ul className="divide-y divide-line lg:hidden">
        {contacts.map((contact) => {
          const lifecycle = lifecycleByContactId?.get(contact.id) ?? "new";
          return (
            <li key={contact.id}>
              <Link
                href={`/contacts/${contact.id}`}
                className="flex items-center gap-3 px-2 py-3.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
                  {contactInitials(contact)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {contactDisplayName(contact)}
                    </span>
                    <Badge tone={CONTACT_LIFECYCLE_TONE[lifecycle]} className={lifecycle === "lost" ? "opacity-70" : undefined}>
                      {CONTACT_LIFECYCLE_LABEL[lifecycle]}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-3">
                    {contact.company_name || secondaryLine(contact)}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-4" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
