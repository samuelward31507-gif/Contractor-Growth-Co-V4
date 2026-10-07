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
import { contactLifecycleFromCanonical, type ContactLifecycleStage } from "@/lib/customers/lifecycle-stage";
import { summarizeOpenLeadValue } from "@/lib/contacts/open-lead-value";
import { derivePersonLifecycle, findPersonNextStep, type NextStep } from "@/lib/people/next-step";
import { loadLifecyclePolicy } from "@/lib/people/lifecycle-policy";
import { getWaitingConversationIds } from "@/lib/conversations/waiting";
import Link from "next/link";
import { PageHeader } from "@/lib/ui/page-header";
import { getTerminology } from "@/lib/verticals/terminology";
import { Panel } from "@/lib/ui/section-card";
import { AddContactButton } from "@/app/(app)/contacts/_components/add-contact-button";
import { TEMPERATURE_LABELS } from "@/lib/leads/format";
import { PeopleEmptyState } from "./_components/people-empty-state";
import { PeopleSearch } from "./_components/people-search";
import { PeopleTable } from "./_components/people-table";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { filterPeople, type PeopleView } from "@/lib/people/filter";
import { AddLeadButton } from "@/app/(app)/leads/_components/add-lead-button";
import { getOrganizationTimezone } from "@/lib/settings/queries";

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

function normalizeView(value: string | undefined): PeopleView {
  return value === "leads" ? "leads" : "all";
}

const TEMPERATURE_CHIPS: (LeadTemperature | "all")[] = ["all", "hot", "warm", "cold"];

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
  // Final Batch 3: the Leads view is everyone with an open lead (any
  // temperature); temperature only narrows it. It used to BE the hot filter.
  const view = normalizeView(typeof params.view === "string" ? params.view : undefined);
  const leadsView = view === "leads" || temperature !== "all";

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const [allContacts, leads, estimates, jobs, appointments, reviewRequests, conversations, invoices, waiting, timeZone, lifecyclePolicy] = await Promise.all([
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
    // Phase 2-13 (§3): one paged org read of the conversations waiting on the business.
    getWaitingConversationIds(supabase, membership.organizationId),
    // Phase 3 (W1): next-step appointment times in the organization's timezone, as on the Person page.
    getOrganizationTimezone(supabase, membership.organizationId),
    // Final Batch 3: one policy for every row's canonical lifecycle.
    loadLifecyclePolicy(supabase, membership.organizationId),
  ]);

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
  const jobContactId = new Map(jobs.map((job) => [job.id, job.contact_id]));
  const reviewRequestsByContactId = new Map<string, typeof reviewRequests>();
  for (const request of reviewRequests) {
    const contactId = request.job_id ? jobContactId.get(request.job_id) : null;
    if (!contactId) continue;
    reviewRequestsByContactId.set(contactId, [...(reviewRequestsByContactId.get(contactId) ?? []), request]);
  }

  // Final Batch 3: the badge and the next step both come from ONE canonical
  // lifecycle per person (lib/lifecycle via lib/people/next-step.ts), so they
  // can never disagree and a stale lead status never outranks newer records.
  const valueByContactId = new Map<string, ReturnType<typeof summarizeOpenLeadValue>>();
  const nextStepByContactId = new Map<string, NextStep | null>();
  const lifecycleByContactId = new Map<string, ContactLifecycleStage>();
  for (const contact of allContacts) {
    valueByContactId.set(contact.id, summarizeOpenLeadValue(leadsByContactId.get(contact.id) ?? []));
    const person = {
      contactId: contact.id,
      leads: leadsByContactId.get(contact.id) ?? [],
      appointments: appointmentsByContactId.get(contact.id) ?? [],
      estimates: estimatesByContactId.get(contact.id) ?? [],
      jobs: jobsByContactId.get(contact.id) ?? [],
      invoices: invoicesByContactId.get(contact.id) ?? [],
      reviewRequests: reviewRequestsByContactId.get(contact.id) ?? [],
      policy: lifecyclePolicy,
    };
    const lifecycle = derivePersonLifecycle(person);
    lifecycleByContactId.set(contact.id, contactLifecycleFromCanonical(lifecycle));
    nextStepByContactId.set(
      contact.id,
      findPersonNextStep({
        ...person,
        conversations: conversationsByContactId.get(contact.id) ?? [],
        waitingConversationIds: waiting.ids,
        timeZone,
        jobsEnabled: membership.vertical === "contractor",
        lifecycle,
      }),
    );
  }

  const viewFiltered = filterPeople(allContacts, temperatureByContactId, { view, temperature });
  const contacts = sortContacts(filterContacts(viewFiltered, query), sort);

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader
        eyebrow={leadsView ? "People · Leads" : "People"}
        // Trackpr 2.0 (step 2G): the title follows the nav entry that lands
        // here - Leads is everyone with an open lead (Final Batch 3: every
        // temperature, not only hot), Contacts (Members for a gym) is everyone.
        title={leadsView ? "Leads" : getTerminology(membership.vertical).contactsLabel}
        description={leadsView ? "Everyone with an open lead - hot, warm and cold." : "Everyone your business is currently working with or has worked with."}
        badge={
          allContacts.length > 0 ? (
            <span className="inline-flex items-center rounded-full bg-inset px-2.5 py-0.5 text-xs font-medium tabular-nums text-ink-2">
              {allContacts.length}
            </span>
          ) : undefined
        }
        action={
          <div className="flex items-center gap-4">
            <Link
              href="/contacts/duplicates"
              className="inline-flex min-h-11 items-center rounded text-sm font-medium text-ink-3 transition-colors hover:text-ink sm:min-h-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Review duplicates
            </Link>
            {allContacts.length > 0 ? <AddContactButton /> : null}
            {/* Final Batch 3: Add Lead lives where leads are worked (it explains "add a contact first" when there are none). */}
            {leadsView ? <AddLeadButton contacts={allContacts} /> : null}
          </div>
        }
      />

      {leadsView ? (
        <nav aria-label="Lead temperature" className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
          {TEMPERATURE_CHIPS.map((chip) => {
            const active = chip === temperature;
            return (
              <Link
                key={chip}
                href={chip === "all" ? "/people?view=leads" : `/people?view=leads&temperature=${chip}`}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3 py-1 font-medium ${active ? "bg-selected text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {chip === "all" ? "All open leads" : TEMPERATURE_LABELS[chip]}
              </Link>
            );
          })}
          <span aria-live="polite">· {contacts.length} shown ·</span>
          <Link href="/people" className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink">
            View everyone
          </Link>
        </nav>
      ) : null}

      {allContacts.length === 0 ? (
        <PeopleEmptyState />
      ) : (
        <Panel>
          <PeopleSearch initialQuery={query} initialSort={sort} initialTemperature={temperature !== "all" ? temperature : undefined} initialView={view !== "all" ? view : undefined} />
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
