import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData, type AttentionItem } from "@/lib/dashboard/queries";
import { syncOpportunities } from "@/lib/opportunities/detect";
import { getOpenOpportunities, type Opportunity } from "@/lib/opportunities/queries";
import { getContacts } from "@/lib/contacts/queries";
import { contactDisplayName } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { QueueCard } from "@/lib/ui/queue-card";
import { surfaceClass } from "@/lib/ui/surface";
import { ATTENTION_COPY, OPPORTUNITY_ONLY_COPY } from "@/lib/today/copy";
import type { StatusTone } from "@/lib/ui/status";

type QueueEntry = {
  key: string;
  tone: StatusTone;
  problemLabel: string;
  age?: string;
  personName: string;
  personHref: string;
  money?: string;
  sentence: string;
  phone?: string | null;
  secondaryHref: string;
  secondaryLabel: string;
  sortValue: number;
};

/** Recovers the raw number behind an AttentionItem's already-formatted "$7,200" display string - never a second, independent dollar calculation, just parsing back what formatCurrency already produced. */
function parseDisplayedCurrency(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Phase 2 (Today pass): "3 things that need you" as a real screen, not
 * just the dashboard's own preview. Reads getDashboardData().attentionItems
 * and getOpenOpportunities - the exact same two reads the dashboard
 * already performs - zero new queries. Sorted by cost of ignoring (real
 * dollar value first, since that's the one universal signal every item
 * doesn't equally have), not recency - a $12,400 quote going cold outranks
 * a review request. Age is intentionally not a secondary sort key:
 * AttentionItem carries no structured timestamp, only a human-readable
 * detail string ("9 days ago") built for display, not parsing - inventing
 * a numeric age from that text would risk silently mis-ranking items on a
 * phrasing this file was never meant to parse. Ties instead keep the
 * server's own existing priority-tier order (Array.prototype.sort is
 * stable), which already reflects urgency for zero-value items.
 */
export default async function TodayPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  // Same ordering reason as dashboard/page.tsx's own call: the Attention
  // Engine and this page's own opportunity read both touch the
  // opportunities table, so this must finish before the Promise.all below
  // to avoid racing a freshly-detected opportunity on first render.
  await syncOpportunities(supabase, membership.organizationId);

  const [data, openOpportunities, contacts] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getOpenOpportunities(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
  ]);

  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));

  const attentionEntries: QueueEntry[] = data.attentionItems.map((item: AttentionItem) => {
    const copy = ATTENTION_COPY[item.kind];
    return {
      key: `attention:${item.id}`,
      tone: copy.tone,
      problemLabel: copy.label,
      // No age: AttentionItem carries no structured timestamp (see this
      // file's own header comment) - the band shows the problem alone
      // rather than a guessed or duplicated age. item.detail is still the
      // one real, correct explanation, used as the card's sentence below.
      personName: item.title,
      personHref: item.href,
      money: item.value ?? undefined,
      sentence: item.detail,
      // No contactId/phone on AttentionItem's own shape - the Call action
      // is only available for the two extra opportunity-only cards below,
      // which do carry a real contact reference. Every attention card still
      // gets its one real action (View, promoted to primary by QueueCard
      // itself when no phone is present).
      phone: null,
      secondaryHref: item.href,
      secondaryLabel: "View",
      sortValue: parseDisplayedCurrency(item.value),
    };
  });

  // The two opportunity types with no matching AttentionItem kind at all
  // (see lib/today/copy.ts's own header comment) - real signal that would
  // otherwise never surface anywhere. contactId/phone ARE available here
  // (Opportunity carries contactId; the org's already-fetched contacts
  // list resolves it to a phone), so these get a genuine Call action.
  const opportunityEntries: QueueEntry[] = openOpportunities
    .filter((opportunity: Opportunity) => OPPORTUNITY_ONLY_COPY[opportunity.type])
    .map((opportunity) => {
      const copy = OPPORTUNITY_ONLY_COPY[opportunity.type]!;
      const contact = opportunity.contactId ? contactsById.get(opportunity.contactId) : undefined;
      const personName = contact ? contactDisplayName(contact) : opportunity.title;
      const personHref = opportunity.contactId ? `/contacts/${opportunity.contactId}` : "/opportunities";
      return {
        key: `opportunity:${opportunity.id}`,
        tone: copy.tone,
        problemLabel: copy.label,
        age: formatRelativeTime(opportunity.createdAt),
        personName,
        personHref,
        money: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : undefined,
        // Real, already-stored description - never invented. Falls back to
        // the copy label itself on the rare row with no description, so
        // the sentence is never blank.
        sentence: opportunity.description ?? copy.label,
        phone: contact?.phone ?? null,
        secondaryHref: personHref,
        secondaryLabel: "View",
        sortValue: parseDisplayedCurrency(opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : null),
      };
    });

  const queue = [...attentionEntries, ...opportunityEntries].sort((a, b) => b.sortValue - a.sortValue);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <h1 className={pageTitleClass}>{queue.length === 0 ? "Nothing needs you" : `${queue.length} thing${queue.length === 1 ? "" : "s"} need${queue.length === 1 ? "s" : ""} you`}</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>{queue.length === 0 ? "You're clear." : "Sorted by what it costs you to ignore it."}</p>
      </div>

      {queue.length === 0 ? (
        <div className={`${surfaceClass} px-6 py-14 text-center`}>
          <p className="text-base font-medium text-slate-900">Nothing needs you.</p>
          <p className="mt-1.5 text-sm text-slate-500">You&apos;re clear.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {queue.map((entry) => (
            <QueueCard
              key={entry.key}
              tone={entry.tone}
              problemLabel={entry.problemLabel}
              age={entry.age}
              personName={entry.personName}
              personHref={entry.personHref}
              money={entry.money}
              sentence={entry.sentence}
              phone={entry.phone}
              secondaryHref={entry.secondaryHref}
              secondaryLabel={entry.secondaryLabel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
