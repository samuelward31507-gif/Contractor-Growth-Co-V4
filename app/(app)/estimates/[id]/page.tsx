import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { getEstimate } from "@/lib/estimates/queries";
import { getJobByEstimateId } from "@/lib/jobs/queries";
import { contactDisplayName, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { successBannerClass } from "@/lib/ui/form";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { ESTIMATE_STATUS_TONE, ESTIMATE_STATUS_ICON } from "../_components/status";
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
    <div className="flex flex-1 flex-col">
      {/*
        ESTIMATE hierarchy: value -> status -> customer -> line items/
        actions. Amount is the number that decides everything else about
        this record, so it leads the header exactly like the Leads detail
        page's own "Estimated value" moment - the two pages deliberately
        share that grammar since both are ultimately about a dollar figure
        and a decision.
      */}
      <DetailHeader
        eyebrow="Estimate"
        backHref="/estimates"
        backLabel="Back to Estimates"
        title={estimate.title}
        subtitle={customerName}
        badges={
          <Badge tone={ESTIMATE_STATUS_TONE[estimate.status]} icon={ESTIMATE_STATUS_ICON[estimate.status]}>
            {ESTIMATE_STATUS_LABELS[estimate.status]}
          </Badge>
        }
        action={<EstimateActions estimate={estimate} contacts={contacts} leads={leads} />}
        meta={
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Amount</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-slate-900">
              {estimate.amount != null ? formatCurrency(estimate.amount) : "—"}
            </p>
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      {estimate.status === "accepted" && job ? (
        <div className={successBannerClass}>
          <p className="font-medium">Job created</p>
          <p>
            This estimate was accepted and a job was created for it.{" "}
            <Link href={`/jobs/${job.id}`} className="font-medium underline">
              View job
            </Link>
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <SectionCard title="Estimate">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
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
          </SectionCard>

          {estimate.lead ? (
            <SectionCard
              title="Lead"
              action={
                <Link href={`/leads/${estimate.lead.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                  View lead
                </Link>
              }
            >
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
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
            </SectionCard>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          {estimate.contact ? (
            <SectionCard
              title="Customer"
              action={
                <Link href={`/contacts/${estimate.contact.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                  View contact
                </Link>
              }
            >
              <dl className="space-y-3">
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
            </SectionCard>
          ) : null}

          <Panel>
            <h2 className={subsectionTitleClass}>Details</h2>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className={detailLabelClass}>Added</dt>
                <dd className={detailValueClass}>{formatContactDate(estimate.created_at)}</dd>
              </div>
              {estimate.updated_at !== estimate.created_at ? (
                <div>
                  <dt className={detailLabelClass}>Last updated</dt>
                  <dd className={detailValueClass}>{formatContactDate(estimate.updated_at)}</dd>
                </div>
              ) : null}
            </dl>
          </Panel>
        </div>
      </div>
      </div>
    </div>
  );
}
