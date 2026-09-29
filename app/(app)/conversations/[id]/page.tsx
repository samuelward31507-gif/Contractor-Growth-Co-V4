import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { ArrowLeft, ChevronDown, Info, SearchX } from "lucide-react";
import {
  getContactAppointments,
  getConversation,
  getMessages,
  pickRelevantAppointment,
} from "@/lib/conversations/queries";
import { getContactLeads } from "@/lib/leads/queries";
import { getContactEstimates } from "@/lib/estimates/queries";
import { getContactJobs } from "@/lib/jobs/queries";
import { getContactInvoices } from "@/lib/invoices/queries";
import { calendarDateInTimeZone } from "@/lib/invoices/domain";
import { getReviewRequestsForJobs } from "@/lib/reviews-referrals/queries";
import { deriveContactLifecycle } from "@/lib/customers/lifecycle-stage";
import { findPersonNextStep } from "@/lib/people/next-step";
import { summarizeOpenLeadValue, formatOpenLeadValueDisplay } from "@/lib/contacts/open-lead-value";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { CHANNEL_LABELS } from "@/lib/conversations/format";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { primaryButtonAutoClass } from "@/lib/ui/form";
import { ConversationStatusBadge } from "../_components/status-badge";
import { ConversationActions } from "./_components/conversation-actions";
import { ConversationContext, type AutomationActivity } from "./_components/conversation-context";
import { MessageComposer } from "./_components/message-composer";
import { MessageThread } from "./_components/message-thread";

export default async function ConversationDetailPage({ params }: PageProps<"/conversations/[id]">) {
  const { id } = await params;

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const conversation = await getConversation(supabase, membership.organizationId, id);

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={SearchX}
          title="Conversation not found"
          description="This conversation may have been removed, or the link is incorrect."
          action={
            <Link href="/conversations" className={primaryButtonAutoClass}>
              Back to Conversations
            </Link>
          }
        />
      </div>
    );
  }

  const [messages, contactAppointments, contactLeads, contactEstimates, contactJobs, contactOptOut, timeZone, contactInvoices] = await Promise.all([
    getMessages(supabase, membership.organizationId, conversation.id),
    conversation.contact_id
      ? getContactAppointments(supabase, membership.organizationId, conversation.contact_id)
      : Promise.resolve([]),
    // Final Major Product Build: scoped reads (never a full org fetch) that
    // power this panel's own lifecycle stage, opportunity value, next step,
    // and Estimate card below - see each scoped query's own comment
    // (lib/leads/queries.ts, lib/estimates/queries.ts, lib/jobs/queries.ts)
    // for why these exist as real `.eq("contact_id", ...)` queries rather
    // than filtering a page-wide fetch in memory.
    conversation.contact_id ? getContactLeads(supabase, membership.organizationId, conversation.contact_id) : Promise.resolve([]),
    conversation.contact_id ? getContactEstimates(supabase, membership.organizationId, conversation.contact_id) : Promise.resolve([]),
    conversation.contact_id ? getContactJobs(supabase, membership.organizationId, conversation.contact_id) : Promise.resolve([]),
    // sms_opt_out isn't part of the conversation query's embedded contact
    // columns (lib/conversations/queries.ts is out of scope for this pass),
    // so it's read directly here, scoped by org + contact id the same way
    // every other query in this codebase is.
    conversation.contact_id
      ? supabase
          .from("contacts")
          .select("sms_opt_out")
          .eq("id", conversation.contact_id)
          .eq("organization_id", membership.organizationId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Trackpr 2.0, Launch Certification QA fix: same fix as
    // app/(app)/contacts/[id]/page.tsx and app/(app)/leads/[id]/page.tsx -
    // ConversationContext's relevant-appointment date/time need the
    // organization's real timezone, or they silently fall back to the
    // server runtime's default (UTC).
    getOrganizationTimezone(supabase, membership.organizationId),
    // Phase 1B-4: this contact's invoices, the same scoped-read shape as
    // getContactEstimates above - feeds the Invoice card and the next step.
    conversation.contact_id ? getContactInvoices(supabase, membership.organizationId, conversation.contact_id) : Promise.resolve([]),
  ]);

  // review_requests are read after contactJobs resolves (needs its own job
  // ids to scope to), the same staged-fetch shape /people/[id]/page.tsx
  // already uses for its own reviewRequests/referralRequests.
  const reviewRequests = await getReviewRequestsForJobs(
    supabase,
    membership.organizationId,
    contactJobs.map((job) => job.id),
  );

  const relevantAppointment = pickRelevantAppointment(contactAppointments);
  const contactName = conversation.contact ? contactDisplayName(conversation.contact) : "No contact";
  const smsOptOut = Boolean(contactOptOut?.data?.sms_opt_out);

  const lifecycleStage = conversation.contact_id
    ? deriveContactLifecycle(conversation.contact_id, {
        leads: contactLeads,
        estimates: contactEstimates,
        jobs: contactJobs,
        appointments: contactAppointments,
        reviewRequests,
      })
    : null;

  const openLeadValueSummary = summarizeOpenLeadValue(contactLeads);
  const openLeadCount = contactLeads.filter((lead) => lead.status !== "won" && lead.status !== "lost").length;
  const openLeadValueDisplay = formatOpenLeadValueDisplay(openLeadValueSummary, openLeadCount, formatCurrency);

  // The current conversation is the only one this scoped fetch has - a
  // narrower input than /people/[id]'s own full conversation list, so the
  // "a conversation is waiting for a reply" branch only ever considers this
  // one thread. Every other branch (appointment/estimate/lead) reads this
  // contact's full, real history exactly like the Person page does.
  const nextStep = conversation.contact_id
    ? findPersonNextStep({ leads: contactLeads, appointments: contactAppointments, estimates: contactEstimates, jobs: contactJobs, conversations: [conversation], invoices: contactInvoices, timeZone })
    : null;

  // Phase 1B-4: the one invoice worth showing next to the thread - an open
  // balance first (sent, then partially paid), else the most recent live
  // invoice; a void-only history shows nothing. Same "most relevant real
  // record" rule as relevantEstimate below.
  const relevantInvoice =
    contactInvoices.find((invoice) => invoice.status === "sent" || invoice.status === "partially_paid") ??
    contactInvoices.find((invoice) => invoice.status !== "void") ??
    null;
  const today = calendarDateInTimeZone(new Date(), timeZone ?? "UTC");

  const relevantEstimate =
    contactEstimates.find((estimate) => estimate.status === "sent") ??
    contactEstimates.find((estimate) => estimate.status === "accepted") ??
    contactEstimates[0] ??
    null;

  // There's no dedicated automation-log query keyed by conversation in
  // scope here - this is derived straight from the messages already loaded
  // above (every AI-sent message in this thread is, by definition,
  // automation activity), not a fabricated figure.
  const aiMessages = messages.filter((message) => message.sender_type === "ai");
  const automationActivity: AutomationActivity = {
    aiEnabled: conversation.ai_enabled,
    aiMessageCount: aiMessages.length,
    lastAiMessageAt: aiMessages.length > 0 ? aiMessages[aiMessages.length - 1].created_at : null,
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        <Link
          href="/conversations"
          aria-label="Back to Conversations"
          className="-m-2 rounded-md p-2 text-ink-3 transition-colors hover:bg-selected hover:text-ink-2 lg:hidden"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Link>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
          {conversation.contact ? contactInitials(conversation.contact) : "?"}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-ink">{contactName}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-ink-3">{CHANNEL_LABELS[conversation.channel]}</span>
            <ConversationStatusBadge status={conversation.status} />
            {conversation.ai_enabled ? <Badge tone="info">AI enabled</Badge> : null}
            {smsOptOut ? <Badge tone="warning">Opted out</Badge> : null}
          </div>
        </div>
        <ConversationActions conversation={conversation} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageThread messages={messages} />
          <MessageComposer conversationId={conversation.id} />
        </div>

        {/* Below xl: a collapsed-by-default disclosure so contact/lead/
            appointment/automation context never squeezes the thread out of
            view - the thread and composer keep the space by default, and
            details are one tap away. At xl+ this is hidden in favor of the
            persistent sidebar below. */}
        <details className="group shrink-0 border-t border-line xl:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-ink sm:px-6">
            <span className="inline-flex items-center gap-2">
              <Info className="h-4 w-4 text-ink-3" aria-hidden />
              Conversation details
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="max-h-[50vh] overflow-y-auto border-t border-line">
            <ConversationContext
              conversation={conversation}
              relevantAppointment={relevantAppointment}
              relevantEstimate={relevantEstimate}
              relevantInvoice={relevantInvoice}
              today={today}
              lifecycleStage={lifecycleStage}
              openLeadValueDisplay={openLeadCount > 0 ? openLeadValueDisplay : null}
              nextStep={nextStep}
              smsOptOut={smsOptOut}
              automationActivity={automationActivity}
              timeZone={timeZone}
            />
          </div>
        </details>

        <div className="hidden shrink-0 overflow-y-auto border-l border-line xl:block xl:w-72">
          <ConversationContext
            conversation={conversation}
            relevantAppointment={relevantAppointment}
            relevantEstimate={relevantEstimate}
            relevantInvoice={relevantInvoice}
            today={today}
            lifecycleStage={lifecycleStage}
            openLeadValueDisplay={openLeadCount > 0 ? openLeadValueDisplay : null}
            nextStep={nextStep}
            smsOptOut={smsOptOut}
            automationActivity={automationActivity}
            timeZone={timeZone}
          />
        </div>
      </div>
    </div>
  );
}
