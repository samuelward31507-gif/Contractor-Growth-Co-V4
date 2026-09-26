import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  attachLastMessages,
  getConversationsResult,
  getLastMessagesByConversationResult,
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

  const [conversationsResult, lastMessagesResult] = await Promise.all([
    getConversationsResult(supabase, membership.organizationId),
    getLastMessagesByConversationResult(supabase, membership.organizationId),
  ]);
  const conversations = conversationsResult.data;
  const lastMessages = lastMessagesResult.data;
  // Trackpr 2.0, Phase 4B (P1 #4): a real Postgrest error on either read
  // must never render as "no conversations" - see getConversationsResult's
  // own comment in lib/conversations/queries.ts.
  const failed = conversationsResult.failed || lastMessagesResult.failed;

  const summary = summarizeConversations(conversations);
  const withActivity = attachLastMessages(conversations, lastMessages);

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-4 pt-6 sm:px-6 sm:pt-8 lg:px-10 lg:pt-10">
      {failed ? (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}
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
