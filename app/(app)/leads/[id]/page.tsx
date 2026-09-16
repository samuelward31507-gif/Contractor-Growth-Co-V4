import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLead } from "@/lib/leads/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { cardClass, cardHeaderClass, cardTitleClass } from "@/lib/ui/card";
import { Icon } from "../../_components/icon";
import { StatusBadge, TemperatureBadge } from "../_components/badges";
import { LeadActions } from "./_components/lead-actions";

export default async function LeadDetailPage({ params }: PageProps<"/leads/[id]">) {
  const { id } = await params;

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

  const [lead, contacts] = await Promise.all([
    getLead(supabase, membership.organizationId, id),
    getContacts(supabase, membership.organizationId),
  ]);

  if (!lead) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Lead not found</h1>
        <p className="text-sm text-slate-500">This lead may have been deleted, or the link is incorrect.</p>
        <Link href="/leads" className="mt-2 text-sm font-medium text-slate-900 hover:underline">
          Back to Leads
        </Link>
      </div>
    );
  }

  const contactName = lead.contact ? contactDisplayName(lead.contact) : "No contact";
  const hasAiInsight = lead.ai_score != null || Boolean(lead.ai_summary);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <Link
        href="/leads"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to Leads
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-900 text-lg font-semibold text-white">
            {lead.contact ? contactInitials(lead.contact) : "?"}
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">{contactName}</h1>
            <p className="text-sm text-slate-500">{lead.service || "General inquiry"}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <StatusBadge status={lead.status} />
              <TemperatureBadge temperature={lead.temperature} />
            </div>
          </div>
        </div>
        <LeadActions lead={lead} contacts={contacts} />
      </div>

      {lead.contact ? (
        <div className={cardClass}>
          <div className={cardHeaderClass}>
            <h2 className={cardTitleClass}>Contact</h2>
            <Link
              href={`/contacts/${lead.contact.id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              View contact
            </Link>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Name</dt>
              <dd className="mt-1 text-sm text-slate-900">{contactDisplayName(lead.contact)}</dd>
            </div>
            {lead.contact.company_name ? (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Company</dt>
                <dd className="mt-1 text-sm text-slate-900">{lead.contact.company_name}</dd>
              </div>
            ) : null}
            {lead.contact.phone ? (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Phone</dt>
                <dd className="mt-1 text-sm text-slate-900">{lead.contact.phone}</dd>
              </div>
            ) : null}
            {lead.contact.email ? (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Email</dt>
                <dd className="mt-1 text-sm text-slate-900">{lead.contact.email}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <h2 className={cardTitleClass}>Opportunity</h2>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Service</dt>
            <dd className="mt-1 text-sm text-slate-900">{lead.service || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Source</dt>
            <dd className="mt-1 text-sm text-slate-900">{lead.source || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Estimated value</dt>
            <dd className="mt-1 text-sm text-slate-900">
              {lead.estimated_value != null ? formatCurrency(lead.estimated_value) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Status</dt>
            <dd className="mt-1">
              <StatusBadge status={lead.status} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Temperature</dt>
            <dd className="mt-1">
              <TemperatureBadge temperature={lead.temperature} />
            </dd>
          </div>
        </dl>
      </div>

      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <h2 className={cardTitleClass}>AI Insight</h2>
        </div>
        <div className="px-5 py-5">
          {hasAiInsight ? (
            <div className="space-y-3">
              {lead.ai_score != null ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Score</dt>
                  <dd className="mt-1 text-sm text-slate-900">{lead.ai_score} / 100</dd>
                </div>
              ) : null}
              {lead.ai_summary ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Summary</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{lead.ai_summary}</dd>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Not analyzed yet.</p>
          )}
        </div>
      </div>

      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <h2 className={cardTitleClass}>Activity</h2>
        </div>
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-slate-500">
            Conversations, appointments, and other activity for this lead will appear here in a
            future update.
          </p>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        Added {formatContactDate(lead.created_at)}
        {lead.updated_at !== lead.created_at ? ` · Updated ${formatContactDate(lead.updated_at)}` : ""}
      </p>
    </div>
  );
}
