import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  attachLastMessages,
  getConversations,
  getLastMessagesByConversation,
  summarizeConversations,
} from "@/lib/conversations/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { ConversationsEmptyState } from "./_components/conversations-empty-state";
import { ConversationsSummary } from "./_components/conversations-summary";
import { ConversationsWorkspace } from "./_components/conversations-workspace";

/**
 * Fetches the full conversation list once and renders it as a persistent
 * left pane alongside whichever route is active below (the index page's
 * "select a conversation" placeholder, or a specific thread) - a genuine
 * list + workspace composition rather than two independent pages.
 */
export default async function ConversationsLayout({ children }: { children: ReactNode }) {
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

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-4 pt-6 sm:px-6 sm:pt-8 lg:px-10 lg:pt-10">
      {conversations.length === 0 ? (
        <>
          <PageHeader title="Conversations" description="Every customer conversation in one place, organized by activity." />
          <div className="mt-6">
            <ConversationsSummary summary={summary} />
          </div>
          <div className="mt-6 flex flex-1 pb-6">
            <ConversationsEmptyState />
          </div>
        </>
      ) : (
        <ConversationsWorkspace conversations={withActivity} summary={summary}>
          {children}
        </ConversationsWorkspace>
      )}
    </div>
  );
}
