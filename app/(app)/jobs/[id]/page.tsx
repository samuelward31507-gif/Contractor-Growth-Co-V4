import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getJob } from "@/lib/jobs/queries";
import { getLeads } from "@/lib/leads/queries";
import { getReviewRequestForJob, getReferralRequestForJob } from "@/lib/reviews-referrals/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import { STATUS_LABELS as ESTIMATE_STATUS_LABELS } from "@/lib/estimates/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { detailLabelClass, detailValueClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Icon } from "../../_components/icon";
import { JobStatusBadge } from "../_components/status-badge";
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
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <Link
        href="/jobs"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to Jobs
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{job.title}</h1>
          <p className="text-sm text-slate-500">{customerName}</p>
          <div className="mt-1.5">
            <JobStatusBadge status={job.status} />
          </div>
        </div>
        <JobActions job={job} />
      </div>

      <div className="border-t border-slate-200 pt-8">
        <h2 className={subsectionTitleClass}>Job</h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div>
            <dt className={detailLabelClass}>Amount</dt>
            <dd className={detailValueClass}>{job.amount != null ? formatCurrency(job.amount) : "—"}</dd>
          </div>
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
      </div>

      <ReviewReferralPanel jobId={job.id} reviewRequest={reviewRequest} referralRequest={referralRequest} leadOptions={leadOptions} />

      {job.estimate ? (
        <div className="border-t border-slate-200 pt-8">
          <div className="flex items-center justify-between">
            <h2 className={subsectionTitleClass}>Estimate</h2>
            <Link href={`/estimates/${job.estimate.id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              View estimate
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
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
        </div>
      ) : null}

      {job.contact ? (
        <div className="border-t border-slate-200 pt-8">
          <div className="flex items-center justify-between">
            <h2 className={subsectionTitleClass}>Customer</h2>
            <Link href={`/contacts/${job.contact.id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              View contact
            </Link>
          </div>
          <div className="mt-4 flex items-center gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-medium text-slate-600">
              {contactInitials(job.contact)}
            </span>
            <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
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
          </div>
        </div>
      ) : null}

      {job.lead ? (
        <div className="border-t border-slate-200 pt-8">
          <div className="flex items-center justify-between">
            <h2 className={subsectionTitleClass}>Lead</h2>
            <Link href={`/leads/${job.lead.id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              View lead
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
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
        </div>
      ) : null}

      <p className="text-xs text-slate-400">
        Added {formatContactDate(job.created_at)}
        {job.updated_at !== job.created_at ? ` · Updated ${formatContactDate(job.updated_at)}` : ""}
      </p>
    </div>
  );
}
