import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getJob } from "@/lib/jobs/queries";
import { getLeads } from "@/lib/leads/queries";
import { getReviewRequestForJob, getReferralRequestForJob } from "@/lib/reviews-referrals/queries";
import { contactDisplayName, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { JOB_STATUS_TONE, JOB_STATUS_ICON } from "../_components/status";
import { JobActions } from "./_components/job-actions";
import { ReviewReferralPanel } from "./_components/review-referral-panel";

export default async function JobDetailPage({ params }: PageProps<"/jobs/[id]">) {
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

  const job = await getJob(supabase, membership.organizationId, id);

  if (!job) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Job not found</h1>
        <p className="text-sm text-slate-500">This job may have been deleted, or the link is incorrect.</p>
        <Link href="/jobs" className="mt-2 text-sm font-medium text-slate-900 hover:underline">
          Back to Jobs
        </Link>
      </div>
    );
  }

  const customerName = job.contact ? contactDisplayName(job.contact) : "No contact";

  const [reviewRequest, referralRequest, leads] = await Promise.all([
    getReviewRequestForJob(supabase, membership.organizationId, job.id),
    getReferralRequestForJob(supabase, membership.organizationId, job.id),
    getLeads(supabase, membership.organizationId),
  ]);
  const leadOptions = leads
    .filter((lead) => lead.id !== job.lead_id)
    .map((lead) => ({ id: lead.id, label: lead.service || `Lead ${lead.id.slice(0, 8)}` }));

  return (
    <div className="flex flex-1 flex-col">
      {/*
        JOB hierarchy: status -> value/payment -> customer -> schedule ->
        activity. Amount leads the header exactly like Lead/Estimate's own
        headline number - this is a contracted amount, not collected
        revenue.
      */}
      <DetailHeader
        eyebrow="Job"
        backHref="/jobs"
        backLabel="Back to Jobs"
        title={job.title}
        subtitle={customerName}
        badges={
          <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
            {JOB_STATUS_LABELS[job.status]}
          </Badge>
        }
        action={<JobActions job={job} />}
        meta={
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Amount</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-slate-900">
              {job.amount != null ? formatCurrency(job.amount) : "—"}
            </p>
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <SectionCard title="Job">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
              <div>
                <dt className={detailLabelClass}>Created</dt>
                <dd className={detailValueClass}>{formatContactDate(job.created_at)}</dd>
              </div>
              <div>
                <dt className={detailLabelClass}>Started</dt>
                <dd className={detailValueClass}>{job.started_at ? formatContactDate(job.started_at) : "—"}</dd>
              </div>
              <div>
                <dt className={detailLabelClass}>Completed</dt>
                <dd className={detailValueClass}>{job.completed_at ? formatContactDate(job.completed_at) : "—"}</dd>
              </div>
            </dl>
            {job.notes ? (
              <div className="mt-4">
                <dt className={detailLabelClass}>Notes</dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{job.notes}</dd>
              </div>
            ) : null}
          </SectionCard>

          {job.estimate ? (
            <SectionCard
              title="Estimate"
              action={
                <Link href={`/estimates/${job.estimate.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                  View estimate
                </Link>
              }
            >
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                <div>
                  <dt className={detailLabelClass}>Title</dt>
                  <dd className={detailValueClass}>{job.estimate.title}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Estimate status</dt>
                  <dd className={detailValueClass}>{ESTIMATE_STATUS_LABELS[job.estimate.status]}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Estimate amount</dt>
                  <dd className={detailValueClass}>
                    {job.estimate.amount != null ? formatCurrency(job.estimate.amount) : "—"}
                  </dd>
                </div>
              </dl>
            </SectionCard>
          ) : null}

          {job.lead ? (
            <SectionCard
              title="Lead"
              action={
                <Link href={`/leads/${job.lead.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                  View lead
                </Link>
              }
            >
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <div>
                  <dt className={detailLabelClass}>Service</dt>
                  <dd className={detailValueClass}>{job.lead.service || "—"}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Lead status</dt>
                  <dd className={detailValueClass}>{LEAD_STATUS_LABELS[job.lead.status]}</dd>
                </div>
                <div>
                  <dt className={detailLabelClass}>Temperature</dt>
                  <dd className={detailValueClass}>{TEMPERATURE_LABELS[job.lead.temperature]}</dd>
                </div>
              </dl>
            </SectionCard>
          ) : null}

          {/* Review/referral is the final stage of a job's lifecycle - the
              customer-facing outcome after everything else about this job's
              own record has already been read - so it reads last in the main
              column, not ahead of the record's own facts. */}
          <ReviewReferralPanel jobId={job.id} reviewRequest={reviewRequest} referralRequest={referralRequest} leadOptions={leadOptions} />
        </div>

        <div className="flex flex-col gap-6">
          {job.contact ? (
            <SectionCard
              title="Customer"
              action={
                <Link href={`/contacts/${job.contact.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                  View contact
                </Link>
              }
            >
              <dl className="space-y-3">
                <div>
                  <dt className={detailLabelClass}>Name</dt>
                  <dd className={detailValueClass}>{contactDisplayName(job.contact)}</dd>
                </div>
                {job.contact.phone ? (
                  <div>
                    <dt className={detailLabelClass}>Phone</dt>
                    <dd className={detailValueClass}>{job.contact.phone}</dd>
                  </div>
                ) : null}
                {job.contact.email ? (
                  <div>
                    <dt className={detailLabelClass}>Email</dt>
                    <dd className={detailValueClass}>{job.contact.email}</dd>
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
                <dd className={detailValueClass}>{formatContactDate(job.created_at)}</dd>
              </div>
              {job.updated_at !== job.created_at ? (
                <div>
                  <dt className={detailLabelClass}>Last updated</dt>
                  <dd className={detailValueClass}>{formatContactDate(job.updated_at)}</dd>
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
