import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { filterContacts, getContacts, type Contact } from "@/lib/contacts/queries";
import { getLeads, type Lead, type LeadTemperature } from "@/lib/leads/queries";
import { getEstimates } from "@/lib/estimates/queries";
import { getJobs } from "@/lib/jobs/queries";
import { getAppointments } from "@/lib/appointments/queries";
import { getReviewRequests } from "@/lib/reviews-referrals/queries";
import { getConversations } from "@/lib/conversations/queries";
import { getInvoices } from "@/lib/invoices/queries";
import { deriveContactLifecycle, type ContactLifecycleStage } from "@/lib/customers/lifecycle-stage";
import { summarizeOpenLeadValue } from "@/lib/contacts/open-lead-value";
import { findPersonNextStep, type NextStep } from "@/lib/people/next-step";
import Link from "next/link";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { AddContactButton } from "@/app/(app)/contacts/_components/add-contact-button";
import { TEMPERATURE_LABELS } from "@/lib/leads/format";
import { PeopleEmptyState } from "./_components/people-empty-state";
import { PeopleSearch } from "./_components/people-search";
import { PeopleTable } from "./_components/people-table";

function groupByContactId<T extends { contact_id: string | null }>(records: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const record of records) {
    if (!record.contact_id) continue;
    const bucket = map.get(record.contact_id);
    if (bucket) bucket.push(record);
    else map.set(record.contact_id, [record]);
  }
  return map;
}

export type PersonSort = "newest" | "oldest" | "name_asc";
const VALID_SORTS = new Set<string>(["newest", "oldest", "name_asc"]);
const OPEN_LEAD_STATUSES = new Set<Lead["status"]>(["new", "contacted", "qualified", "appointment", "estimate"]);
const VALID_TEMPERATURES = new Set<string>(["hot", "warm", "cold"]);

function normalizeSort(value: string | undefined): PersonSort {
  return value && VALID_SORTS.has(value) ? (value as PersonSort) : "newest";
}

function normalizeTemperature(value: string | undefined): LeadTemperature | "all" {
  return value && VALID_TEMPERATURES.has(value) ? (value as LeadTemperature) : "all";
}

function personSortName(contact: Contact): string {
  return [contact.last_name, contact.first_name].filter(Boolean).join(" ").trim().toLowerCase() || "zzz";
}

function sortContacts(contacts: Contact[], sort: PersonSort): Contact[] {
  const sorted = [...contacts];
  switch (sort) {
    case "oldest":
      sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      break;
    case "name_asc":
      sorted.sort((a, b) => personSortName(a).localeCompare(personSortName(b)));
      break;
    case "newest":
    default:
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }
  return sorted;
}

/**
 * Phase 3 (People pass): one list, no Lead-vs-Contact distinction - the
 * repo's own contacts/[id]/page.tsx and leads/[id]/page.tsx comments already
 * flagged this merge as deferred twice. This page reuses the exact query set
 * contacts/page.tsx already performs (getContacts/getLeads/getEstimates/
 * getJobs/getAppointments/getReviewRequests) - zero new queries - and adds
 * one presentation-only derivation on top: each contact's still-open lead's
 * temperature (most recently created, if more than one is open), the same
 * hot/warm signal the old /leads list surfaced, so it isn't lost by merging
 * into one view.
 *
 * IA consolidation pass: /customers, /leads, and /contacts now all redirect
 * here (see their own page.tsx files) - this is the one real list for the
 * "who am I working with" question. The `temperature` filter below is what
 * makes that a safe consolidation for /leads specifically: its own real
 * value was never the list itself (identical rows to Contacts) but the
 * hot/warm/cold filter, which Today's own "N hot leads" link
 * (/people?temperature=hot) and this page's own filter chip now both read
 * from the exact same already-computed temperatureByContactId map.
 */
export default async function PeoplePage({ searchParams }: PageProps<"/people">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const sort = normalizeSort(typeof params.sort === "string" ? params.sort : undefined);
  const temperature = normalizeTemperature(typeof params.temperature === "string" ? params.temperature : undefined);

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const [allContacts, leads, estimates, jobs, appointments, reviewRequests, conversations, invoices] = await Promise.all([
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getEstimates(supabase, membership.organizationId),
    getJobs(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getReviewRequests(supabase, membership.organizationId),
    getConversations(supabase, membership.organizationId),
    // Phase 1B-4: this org's invoices, bucketed per contact below exactly
    // like estimates/jobs, so a completed job's next step can read its live
    // invoice ("Collect payment" / "Create invoice") - see lib/people/next-step.ts.
    getInvoices(supabase, membership.organizationId),
  ]);
  const lifecycleByContactId = new Map<string, ContactLifecycleStage>(
    allContacts.map((contact) => [contact.id, deriveContactLifecycle(contact.id, { leads, estimates, jobs, appointments, reviewRequests })]),
  );

  const temperatureByContactId = new Map<string, LeadTemperature>();
  const leadsByContactId = groupByContactId(leads);
  for (const contact of allContacts) {
    const openLeads = (leadsByContactId.get(contact.id) ?? [])
      .filter((lead) => OPEN_LEAD_STATUSES.has(lead.status))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (openLeads.length > 0) {
      temperatureByContactId.set(contact.id, openLeads[0].temperature);
    }
  }

  // Value and next-step reuse the exact same per-record buckets - each
  // is real, already-established logic (open-lead-value.ts backs the
  // contact detail page's own "Open opportunity value" stat; next-step.ts
  // backs /people/[id]'s own "What happens next") applied per-row instead
  // of to one contact at a time.
  const estimatesByContactId = groupByContactId(estimates);
  const jobsByContactId = groupByContactId(jobs);
  const appointmentsByContactId = groupByContactId(appointments);
  const conversationsByContactId = groupByContactId(conversations);
  const invoicesByContactId = groupByContactId(invoices);

  const valueByContactId = new Map<string, ReturnType<typeof summarizeOpenLeadValue>>();
  const nextStepByContactId = new Map<string, NextStep | null>();
  for (const contact of allContacts) {
    valueByContactId.set(contact.id, summarizeOpenLeadValue(leadsByContactId.get(contact.id) ?? []));
    nextStepByContactId.set(
      contact.id,
      findPersonNextStep({
        leads: leadsByContactId.get(contact.id) ?? [],
        appointments: appointmentsByContactId.get(contact.id) ?? [],
        estimates: estimatesByContactId.get(contact.id) ?? [],
        jobs: jobsByContactId.get(contact.id) ?? [],
        conversations: conversationsByContactId.get(contact.id) ?? [],
        invoices: invoicesByContactId.get(contact.id) ?? [],
      }),
    );
  }

  const temperatureFiltered = temperature === "all" ? allContacts : allContacts.filter((contact) => temperatureByContactId.get(contact.id) === temperature);
  const contacts = sortContacts(filterContacts(temperatureFiltered, query), sort);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="People"
        description="Everyone your business is currently working with or has worked with."
        badge={
          allContacts.length > 0 ? (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-slate-600">
              {allContacts.length}
            </span>
          ) : undefined
        }
        action={
          <div className="flex items-center gap-4">
            <Link
              href="/contacts/duplicates"
              className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Review duplicates
            </Link>
            {allContacts.length > 0 ? <AddContactButton /> : null}
          </div>
        }
      />

      {temperature !== "all" ? (
        <p className="text-sm text-slate-500">
          Showing {TEMPERATURE_LABELS[temperature].toLowerCase()} leads only ({contacts.length}) ·{" "}
          <Link href="/people" className="font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900">
            View everyone
          </Link>
        </p>
      ) : null}

      {allContacts.length === 0 ? (
        <PeopleEmptyState />
      ) : (
        <Panel>
          <PeopleSearch initialQuery={query} initialSort={sort} initialTemperature={temperature !== "all" ? temperature : undefined} />
          <div className="mt-5">
            <PeopleTable
              contacts={contacts}
              query={query}
              lifecycleByContactId={lifecycleByContactId}
              temperatureByContactId={temperatureByContactId}
              valueByContactId={valueByContactId}
              nextStepByContactId={nextStepByContactId}
            />
          </div>
        </Panel>
      )}
    </div>
  );
}
