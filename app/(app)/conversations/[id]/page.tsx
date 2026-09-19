import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ChevronDown, Info, SearchX } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  getContactAppointments,
  getConversation,
  getMessages,
  pickRelevantAppointment,
} from "@/lib/conversations/queries";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
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

  const [messages, contactAppointments, contactOptOut] = await Promise.all([
    getMessages(supabase, membership.organizationId, conversation.id),
    conversation.contact_id
      ? getContactAppointments(supabase, membership.organizationId, conversation.contact_id)
      : Promise.resolve([]),
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
  ]);

  const relevantAppointment = pickRelevantAppointment(contactAppointments);
  const contactName = conversation.contact ? contactDisplayName(conversation.contact) : "No contact";
  const smsOptOut = Boolean(contactOptOut?.data?.sms_opt_out);

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
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-6">
        <Link
          href="/conversations"
          aria-label="Back to Conversations"
          className="text-slate-400 transition-colors hover:text-slate-600 lg:hidden"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Link>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
          {conversation.contact ? contactInitials(conversation.contact) : "?"}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-slate-900">{contactName}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">{CHANNEL_LABELS[conversation.channel]}</span>
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
        <details className="group shrink-0 border-t border-slate-200 xl:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-slate-900 sm:px-6">
            <span className="inline-flex items-center gap-2">
              <Info className="h-4 w-4 text-slate-400" aria-hidden />
              Conversation details
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="max-h-[50vh] overflow-y-auto border-t border-slate-100">
            <ConversationContext
              conversation={conversation}
              relevantAppointment={relevantAppointment}
              smsOptOut={smsOptOut}
              automationActivity={automationActivity}
            />
          </div>
        </details>

        <div className="hidden shrink-0 overflow-y-auto border-l border-slate-200 xl:block xl:w-72">
          <ConversationContext
            conversation={conversation}
            relevantAppointment={relevantAppointment}
            smsOptOut={smsOptOut}
            automationActivity={automationActivity}
          />
        </div>
      </div>
    </div>
  );
}
