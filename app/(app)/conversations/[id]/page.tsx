import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  getContactAppointments,
  getConversation,
  getMessages,
  pickRelevantAppointment,
} from "@/lib/conversations/queries";
import { contactDisplayName } from "@/lib/contacts/format";
import { CHANNEL_LABELS } from "@/lib/conversations/format";
import { cardClass } from "@/lib/ui/card";
import { Icon } from "../../_components/icon";
import { ConversationStatusBadge } from "../_components/status-badge";
import { ConversationActions } from "./_components/conversation-actions";
import { ConversationContext } from "./_components/conversation-context";
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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Conversation not found</h1>
        <p className="text-sm text-slate-500">
          This conversation may have been removed, or the link is incorrect.
        </p>
        <Link href="/conversations" className="mt-2 text-sm font-medium text-slate-900 hover:underline">
          Back to Conversations
        </Link>
      </div>
    );
  }

  const [messages, contactAppointments] = await Promise.all([
    getMessages(supabase, membership.organizationId, conversation.id),
    conversation.contact_id
      ? getContactAppointments(supabase, membership.organizationId, conversation.contact_id)
      : Promise.resolve([]),
  ]);

  const relevantAppointment = pickRelevantAppointment(contactAppointments);
  const contactName = conversation.contact ? contactDisplayName(conversation.contact) : "No contact";

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <Link
        href="/conversations"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to Conversations
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{contactName}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {CHANNEL_LABELS[conversation.channel]}
            </span>
            <ConversationStatusBadge status={conversation.status} />
            {conversation.ai_enabled ? (
              <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                AI Enabled
              </span>
            ) : null}
          </div>
        </div>
        <ConversationActions conversation={conversation} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className={`${cardClass} flex min-h-[28rem] flex-col`}>
            <MessageThread messages={messages} />
            <MessageComposer conversationId={conversation.id} />
          </div>
        </div>
        <ConversationContext conversation={conversation} relevantAppointment={relevantAppointment} />
      </div>
    </div>
  );
}
