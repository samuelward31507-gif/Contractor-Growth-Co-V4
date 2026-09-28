import Link from "next/link";
import { ChevronRight, Search, Phone, Mail, Building2 } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { Table, TableHeadCell, TableBody, TableRow } from "@/lib/ui/table";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
import type { Contact } from "@/lib/contacts/queries";
import type { LeadTemperature } from "@/lib/leads/queries";
import { TEMPERATURE_LABELS } from "@/lib/leads/format";
import { LEAD_TEMPERATURE_TONE } from "@/app/(app)/leads/_components/lead-status";
import { CONTACT_LIFECYCLE_LABEL, CONTACT_LIFECYCLE_TONE, type ContactLifecycleStage } from "@/lib/customers/lifecycle-stage";
import type { OpenLeadValueSummary } from "@/lib/contacts/open-lead-value";
import type { NextStep } from "@/lib/people/next-step";
import { formatCurrency } from "@/lib/dashboard/format";

// Next step and Value are both short, fixed-feeling strings ("Follow up
// with customer", "$21,500") - giving them an `fr` share the way Person/
// Details need (real names, real company/phone/email pairs, genuinely
// variable-length) left them stretching across most of a wide desktop
// viewport as dead space whenever their value is short or "—". Person and
// Details absorb all the flexible growth instead; every other column is a
// fixed cap sized to its real content.
// Final visual acceptance pass: Details' own fixed-column neighbors
// (Lead/Status/Value/Next step) were trimmed a few px each - real emails
// like "samuelward31507@gmail.com" were clipping mid-domain at common
// laptop widths (1440px) despite Value/Next step sitting mostly empty on
// the very same rows. The freed width goes to Details' own `fr` share so
// a full email/phone pair actually fits before it needs to truncate.
const ROW_GRID = "grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_90px_125px_100px_185px_20px]";

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

/** Never renders a bare $0 for "no open value known" - matches contact detail's own formatOpenLeadValueDisplay rule, just without a separate open-lead count param (a table row already shows the Lead temperature column, so "no badge + no value" reads as unambiguous). */
function ValueCell({ value }: { value?: OpenLeadValueSummary }) {
  if (!value || (value.knownValue === 0 && value.unknownValueCount === 0)) {
    return <span className="text-sm text-slate-300">—</span>;
  }
  if (value.knownValue === 0 && value.unknownValueCount > 0) {
    return <span className="text-sm text-slate-400">Unknown</span>;
  }
  return <span className="text-sm font-medium tabular-nums text-slate-900">{formatCurrency(value.knownValue)}</span>;
}

function NextStepCell({ nextStep }: { nextStep?: NextStep | null }) {
  if (!nextStep) return <span className="text-sm text-slate-300">—</span>;
  return (
    <span className="flex min-w-0 flex-col">
      <span className={`truncate text-sm ${nextStep.attention ? "font-medium text-amber-700" : "text-slate-700"}`}>{nextStep.label}</span>
      {nextStep.detail ? <span className="truncate text-xs text-slate-400">{nextStep.detail}</span> : null}
    </span>
  );
}

/**
 * Phase 3 (People pass): a single list, no Lead-vs-Contact split - the exact
 * merge the plan's own "highest risk" phase calls for. Adapted from
 * contacts-table.tsx's own visual/responsive pattern (desktop grid + mobile
 * list) rather than rebuilding it - only two things differ: rows link to
 * /people/{id} instead of /contacts/{id}, and a temperature badge (the same
 * LEAD_TEMPERATURE_TONE/TEMPERATURE_LABELS the Leads pipeline already uses)
 * appears for anyone with a still-open lead, so a hot lead is just as easy to
 * spot here as it always was on the old /leads list. contacts-table.tsx
 * itself, and the /contacts route it serves, are untouched.
 *
 * Redesign pass: adds Value (open lead value, same figure the contact detail
 * page's own hero stat shows) and Next step (the same priority chain
 * /people/[id] uses) columns, and now sits on the shared Table/TableRow
 * primitive instead of a hand-rolled grid.
 */
export function PeopleTable({
  contacts,
  query,
  lifecycleByContactId,
  temperatureByContactId,
  valueByContactId,
  nextStepByContactId,
}: {
  contacts: Contact[];
  query: string;
  lifecycleByContactId?: Map<string, ContactLifecycleStage>;
  /** Present only for a contact with a still-open (not won/lost) lead - see app/(app)/people/page.tsx's own header comment for how this is derived. */
  temperatureByContactId?: Map<string, LeadTemperature>;
  valueByContactId?: Map<string, OpenLeadValueSummary>;
  nextStepByContactId?: Map<string, NextStep | null>;
}) {
  if (contacts.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title={`No one matches "${query}"`}
        description="Try a different name, phone number, email, or company."
      />
    );
  }

  return (
    <div>
      <Table columns={ROW_GRID}>
        <TableHeadCell>Person</TableHeadCell>
        <TableHeadCell>Details</TableHeadCell>
        <TableHeadCell>Lead</TableHeadCell>
        <TableHeadCell>Status</TableHeadCell>
        <TableHeadCell>Value</TableHeadCell>
        <TableHeadCell>Next step</TableHeadCell>
        <span />
      </Table>
      <TableBody>
        {contacts.map((contact) => {
          const lifecycle = lifecycleByContactId?.get(contact.id) ?? "new";
          const temperature = temperatureByContactId?.get(contact.id);
          const value = valueByContactId?.get(contact.id);
          const nextStep = nextStepByContactId?.get(contact.id);
          return (
            <TableRow key={contact.id} href={`/people/${contact.id}`} columns={ROW_GRID} tone={nextStep?.attention ? "warning" : "neutral"}>
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
              <span>
                {temperature ? (
                  <Badge tone={LEAD_TEMPERATURE_TONE[temperature]}>{TEMPERATURE_LABELS[temperature]}</Badge>
                ) : (
                  <span className="text-xs text-slate-300">—</span>
                )}
              </span>
              <span>
                <Badge tone={CONTACT_LIFECYCLE_TONE[lifecycle]} className={lifecycle === "lost" ? "opacity-70" : undefined}>
                  {CONTACT_LIFECYCLE_LABEL[lifecycle]}
                </Badge>
              </span>
              <ValueCell value={value} />
              <NextStepCell nextStep={nextStep} />
              <ChevronRight
                className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500"
                aria-hidden
              />
            </TableRow>
          );
        })}
      </TableBody>

      <ul className="divide-y divide-slate-100 lg:hidden">
        {contacts.map((contact) => {
          const lifecycle = lifecycleByContactId?.get(contact.id) ?? "new";
          const temperature = temperatureByContactId?.get(contact.id);
          const value = valueByContactId?.get(contact.id);
          const nextStep = nextStepByContactId?.get(contact.id);
          return (
            <li key={contact.id}>
              <Link
                href={`/people/${contact.id}`}
                className="flex items-center gap-3 px-2 py-3.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                  {contactInitials(contact)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">
                      {contactDisplayName(contact)}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {temperature ? <Badge tone={LEAD_TEMPERATURE_TONE[temperature]}>{TEMPERATURE_LABELS[temperature]}</Badge> : null}
                      <Badge tone={CONTACT_LIFECYCLE_TONE[lifecycle]} className={lifecycle === "lost" ? "opacity-70" : undefined}>
                        {CONTACT_LIFECYCLE_LABEL[lifecycle]}
                      </Badge>
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-slate-500">{contact.company_name || secondaryLine(contact)}</span>
                    {value && (value.knownValue > 0 || value.unknownValueCount > 0) ? (
                      <span className="shrink-0 text-xs font-medium tabular-nums text-slate-600">
                        {value.knownValue > 0 ? formatCurrency(value.knownValue) : "Unknown"}
                      </span>
                    ) : null}
                  </span>
                  {nextStep ? (
                    <span className={`mt-0.5 block truncate text-xs ${nextStep.attention ? "font-medium text-amber-700" : "text-slate-400"}`}>
                      {nextStep.label}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
