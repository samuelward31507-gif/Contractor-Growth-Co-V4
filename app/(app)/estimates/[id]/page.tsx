import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { getEstimate } from "@/lib/estimates/queries";
import { getJobByEstimateId } from "@/lib/jobs/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Icon } from "../../_components/icon";
import { EstimateStatusBadge } from "../_components/status-badge";
import { EstimateActions } from "./_components/estimate-actions";

export default async function EstimateDetailPage({ params }: PageProps<"/estimates/[id]">) {
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

  const [estimate, contacts, leads] = await Promise.all([
    getEstimate(supabase, membership.organizationId, id),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
  ]);

  if (!estimate) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Estimate not found</h1>
        <p className="text-sm text-slate-500">This estimate may have been deleted, or the link is incorrect.</p>
        <Link href="/estimates" className="mt-2 text-sm font-medium text-slate-900 hover:underline">
          Back to Estimates
        </Link>
      </div>
    );
  }

  // Only ever set once the estimate has actually been accepted - the same
  // read used by emitJobCreatedFromEstimate's own idempotency check, so
  // this link reflects the real, single job created for this estimate
  // rather than a second, independent lookup path.
  const job = estimate.status === "accepted" ? await getJobByEstimateId(supabase, membership.organizationId, id) : null;

  const customerName = estimate.contact ? contactDisplayName(estimate.contact) : "No contact";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <Link
        href="/estimates"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to Estimates
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{estimate.title}</h1>
          <p className="text-sm text-slate-500">{customerName}</p>
          <div className="mt-1.5">
            <EstimateStatusBadge status={estimate.status} />
          </div>
        </div>
        <EstimateActions estimate={estimate} contacts={contacts} leads={leads} />
      </div>

      {estimate.status === "accepted" && job ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3.5 py-2.5 text-sm">
          <p className="font-medium text-emerald-800">Job created</p>
          <p className="text-emerald-700">
            This estimate was accepted and a job was created for it.{" "}
            {/* Jobs has no detail route yet (tracked separately) - link to
                the list rather than a per-id path that would 404. */}
            <Link href="/jobs" className="font-medium underline">
              View jobs
            </Link>
          </p>
        </div>
      ) : null}

      <div className="border-t border-slate-200 pt-8">
        <h2 className={subsectionTitleClass}>Estimate</h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div>
            <dt className={detailLabelClass}>Amount</dt>
            <dd className={detailValueClass}>{estimate.amount != null ? formatCurrency(estimate.amount) : "—"}</dd>
          </div>
          <div>
            <dt className={detailLabelClass}>Created</dt>
            <dd className={detailValueClass}>{formatContactDate(estimate.created_at)}</dd>
          </div>
          <div>
            <dt className={detailLabelClass}>Sent</dt>
            <dd className={detailValueClass}>{estimate.sent_at ? formatContactDate(estimate.sent_at) : "—"}</dd>
          </div>
          <div>
            <dt className={detailLabelClass}>Responded</dt>
            <dd className={detailValueClass}>{estimate.responded_at ? formatContactDate(estimate.responded_at) : "—"}</dd>
          </div>
          <div>
            <dt className={detailLabelClass}>Expires</dt>
            <dd className={detailValueClass}>{estimate.expires_at ? formatContactDate(estimate.expires_at) : "—"}</dd>
          </div>
        </dl>
        {estimate.notes ? (
          <div className="mt-4">
            <dt className={detailLabelClass}>Notes</dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{estimate.notes}</dd>
          </div>
        ) : null}
      </div>

      {estimate.contact ? (
        <div className="border-t border-slate-200 pt-8">
          <div className="flex items-center justify-between">
            <h2 className={subsectionTitleClass}>Customer</h2>
            <Link href={`/contacts/${estimate.contact.id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              View contact
            </Link>
          </div>
          <div className="mt-4 flex items-center gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-medium text-slate-600">
              {contactInitials(estimate.contact)}
            </span>
            <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
              <div>
                <dt className={detailLabelClass}>Name</dt>
                <dd className={detailValueClass}>{contactDisplayName(estimate.contact)}</dd>
              </div>
              {estimate.contact.phone ? (
                <div>
                  <dt className={detailLabelClass}>Phone</dt>
                  <dd className={detailValueClass}>{estimate.contact.phone}</dd>
                </div>
              ) : null}
              {estimate.contact.email ? (
                <div>
                  <dt className={detailLabelClass}>Email</dt>
                  <dd className={detailValueClass}>{estimate.contact.email}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      ) : null}

      {estimate.lead ? (
        <div className="border-t border-slate-200 pt-8">
          <div className="flex items-center justify-between">
            <h2 className={subsectionTitleClass}>Lead</h2>
            <Link href={`/leads/${estimate.lead.id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              View lead
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
            <div>
              <dt className={detailLabelClass}>Service</dt>
              <dd className={detailValueClass}>{estimate.lead.service || "—"}</dd>
            </div>
            <div>
              <dt className={detailLabelClass}>Lead status</dt>
              <dd className={detailValueClass}>{LEAD_STATUS_LABELS[estimate.lead.status]}</dd>
            </div>
            <div>
              <dt className={detailLabelClass}>Temperature</dt>
              <dd className={detailValueClass}>{TEMPERATURE_LABELS[estimate.lead.temperature]}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <p className="text-xs text-slate-400">
        Added {formatContactDate(estimate.created_at)}
        {estimate.updated_at !== estimate.created_at ? ` · Updated ${formatContactDate(estimate.updated_at)}` : ""}
      </p>
    </div>
  );
}
