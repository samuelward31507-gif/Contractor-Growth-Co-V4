import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  attachLastMessages,
  filterConversations,
  getConversations,
  getLastMessagesByConversation,
  summarizeConversations,
  type ConversationChannel,
  type ConversationStatus,
} from "@/lib/conversations/queries";
import { ConversationsEmptyState } from "./_components/conversations-empty-state";
import { ConversationsList } from "./_components/conversations-list";
import { ConversationsSummary } from "./_components/conversations-summary";
import { ConversationsToolbar } from "./_components/conversations-toolbar";

const VALID_CHANNELS = new Set<string>(["sms", "voice", "email", "web"]);
const VALID_STATUSES = new Set<string>(["open", "closed"]);

function normalizeChannel(value: string | undefined): ConversationChannel | "all" {
  return value && VALID_CHANNELS.has(value) ? (value as ConversationChannel) : "all";
}

function normalizeStatus(value: string | undefined): ConversationStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as ConversationStatus) : "all";
}

export default async function ConversationsPage({ searchParams }: PageProps<"/conversations">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const channel = normalizeChannel(typeof params.channel === "string" ? params.channel : undefined);
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);

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

  const [conversations, lastMessages] = await Promise.all([
    getConversations(supabase, membership.organizationId),
    getLastMessagesByConversation(supabase, membership.organizationId),
  ]);

  const summary = summarizeConversations(conversations);
  const withActivity = attachLastMessages(conversations, lastMessages);
  const filtered = filterConversations(withActivity, { query, channel, status });
  const hasActiveFilters = Boolean(query.trim()) || channel !== "all" || status !== "all";

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Conversations</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every customer conversation in one place, organized by activity.
        </p>
      </div>

      <ConversationsSummary summary={summary} />

      {conversations.length === 0 ? (
        <ConversationsEmptyState />
      ) : (
        <>
          <ConversationsToolbar initialQuery={query} initialChannel={channel} initialStatus={status} />
          <ConversationsList conversations={filtered} hasActiveFilters={hasActiveFilters} />
        </>
      )}
    </div>
  );
}
