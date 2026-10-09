import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
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
import { errorBannerClass, successBannerClass } from "@/lib/ui/form";
import { describeEstimateDeliveryState, getEstimateDeliveryState, type EstimateDeliveryState } from "@/lib/automation/estimate-delivery";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { DetailHeader } from "@/lib/ui/detail-header";
import { ApprovalLinkRow } from "./_components/approval-link-row";
import { headers } from "next/headers";
import { resolveCustomerLinkBaseUrl, buildEstimateApprovalUrl } from "@/lib/estimates/approval-link";
import { ESTIMATE_STATUS_TONE, ESTIMATE_STATUS_ICON } from "../_components/status";
import { EstimateActions } from "./_components/estimate-actions";
import { QuoteDetailsEditor } from "./_components/quote-details-editor";
import { formatQuoteNumber, getEstimateDetails } from "@/lib/estimates/details";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

export default async function EstimateDetailPage({ params }: PageProps<"/estimates/[id]">) {
  const { id } = await params;

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const [estimate, contacts, leads, details] = await Promise.all([
    getEstimate(supabase, membership.organizationId, id),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getEstimateDetails(supabase, membership.organizationId, id),
  ]);

  if (!estimate) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-ink">Estimate not found</h1>
        <p className="text-sm text-ink-3">This estimate may have been deleted, or the link is incorrect.</p>
        <Link href="/money?browse=estimates" className="mt-2 text-sm font-medium text-ink hover:underline">
          Back to Estimates
        </Link>
      </div>
    );
  }

  // Quote Approval Links (V1): the shareable customer-facing URL for this
  // estimate. resolveCustomerLinkBaseUrl() returns null when no base URL is
  // configured (e.g. plain local dev) - the row then explains itself
  // instead of rendering a broken link, mirroring lead-capture-section.tsx.
  const approvalBase = resolveCustomerLinkBaseUrl((await headers()).get("host"));
  const approvalUrl = approvalBase ? buildEstimateApprovalUrl(approvalBase, estimate.approval_token) : null;

  // Only ever set once the estimate has actually been accepted - the same
  // read used by emitJobCreatedFromEstimate's own idempotency check, so
  // this link reflects the real, single job created for this estimate
  // rather than a second, independent lookup path.
  const job = estimate.status === "accepted" ? await getJobByEstimateId(supabase, membership.organizationId, id) : null;
  // Final Batch 3: whether the customer was actually texted - read from the estimate's own delivery execution.
  const deliveryState: EstimateDeliveryState = estimate.status === "draft" ? { state: "not_attempted" } : await getEstimateDeliveryState(supabase, membership.organizationId, id);

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
        eyebrow={details.number != null ? `Estimate · ${formatQuoteNumber(details.number)}` : "Estimate"}
        backHref="/money?browse=estimates"
        backLabel="Back to Estimates"
        title={estimate.title}
        subtitle={customerName}
        badges={
          <Badge tone={ESTIMATE_STATUS_TONE[estimate.status]} icon={ESTIMATE_STATUS_ICON[estimate.status]}>
            {ESTIMATE_STATUS_LABELS[estimate.status]}
          </Badge>
        }
        action={<EstimateActions estimate={estimate} contacts={contacts} leads={leads} hasJob={Boolean(job)} amountFromLineItems={details.lineItems.length > 0} />}
        meta={
          <div>
            <p className="text-xs font-medium text-ink-3">Amount</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-ink">
              {estimate.amount != null ? formatCurrency(estimate.amount) : "—"}
            </p>
          </div>
        }
      />

      <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      {estimate.status === "accepted" && !job ? (
        <div className={errorBannerClass} role="status">
          <p className="font-medium">Accepted · no job yet</p>
          <p>The customer accepted this estimate, but no job exists for it. Use Create Job to start the work.</p>
        </div>
      ) : null}
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
              {estimate.status !== "draft" ? (
                <div>
                  <dt className={detailLabelClass}>Customer text</dt>
                  <dd className={detailValueClass}>{describeEstimateDeliveryState(deliveryState)}</dd>
                </div>
              ) : null}
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
                <dd className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{estimate.notes}</dd>
              </div>
            ) : null}
            <ApprovalLinkRow status={estimate.status} url={approvalUrl} />
          </SectionCard>

          <SectionCard
            title="Customer quote"
            description={estimate.status === "draft" ? "What the customer reads before approving. Locked once the quote is sent." : "Exactly what the customer was sent."}
          >
            <QuoteDetailsEditor estimateId={estimate.id} editable={estimate.status === "draft"} details={details} amount={estimate.amount} />
          </SectionCard>

          {estimate.lead ? (
            <SectionCard
              title="Lead"
              action={
                <Link href={`/leads/${estimate.lead.id}`} className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
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
                <Link href={`/people/${estimate.contact.id}`} className="inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
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
