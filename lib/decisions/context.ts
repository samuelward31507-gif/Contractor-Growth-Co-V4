import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttentionItem } from "@/lib/dashboard/queries";
import { getAutomationDefaultEnabled } from "@/lib/automation/catalog";
import { readInboundCustomerReplyConfig } from "@/lib/automation/settings";
import { isWithinBusinessHours } from "@/lib/automation/outbound-gate";
import { getAiSettings, getBusinessHours } from "@/lib/settings/queries";
import { WAITING_REPLY_CAP, firstUnansweredInboundAt, type DecisionContext, type WaitingConversationState } from "./actor";

/**
 * Phase 2-3: the reads behind "who acts" - a small, fixed number of batched
 * reads per Today request, never one per item.
 *
 * The organization row and automation_settings are request-memoized
 * (React.cache, keyed on the request's Supabase client) and shared with
 * getPrioritizedOpportunities, so neither is read twice in a request.
 */

export type OrganizationAutomationState = { row: { automation_mode: string | null; payment_status: string | null; automation_paused: boolean | null } | null; failed: boolean };

export const getOrganizationAutomationState = cache(async (supabase: SupabaseClient, organizationId: string): Promise<OrganizationAutomationState> => {
  const { data, error } = await supabase.from("organizations").select("automation_mode, payment_status, automation_paused").eq("id", organizationId).maybeSingle();
  return { row: data ?? null, failed: error != null };
});

/** Live, paid and not paused - the outbound gate's own organization checks, failing closed on a missing row or read error. */
export function organizationEligibleForAutomation(state: OrganizationAutomationState): boolean {
  const row = state.row;
  return !state.failed && row != null && row.automation_mode === "live" && row.payment_status === "active" && !row.automation_paused;
}

export type OrganizationAutomationSettings = { enabledById: Map<string, boolean>; configById: Map<string, unknown> };

/** Every automation_settings row for the organization. A failed read yields no rows - each automation then falls back to its catalog default, exactly as getAutomationEnabledMap always has. */
export const getOrganizationAutomationSettings = cache(async (supabase: SupabaseClient, organizationId: string): Promise<OrganizationAutomationSettings> => {
  const { data } = await supabase.from("automation_settings").select("automation_id, enabled, config").eq("organization_id", organizationId);
  const enabledById = new Map<string, boolean>();
  const configById = new Map<string, unknown>();
  for (const row of (data ?? []) as { automation_id: string; enabled: boolean; config: unknown }[]) {
    enabledById.set(row.automation_id, row.enabled);
    configById.set(row.automation_id, row.config);
  }
  return { enabledById, configById };
});

const automationEnabled = (settings: OrganizationAutomationSettings, automationId: string) => settings.enabledById.get(automationId) ?? getAutomationDefaultEnabled(automationId);

/** How many of each waiting conversation's newest messages are read to find its first unanswered inbound message. */
const WAITING_MESSAGE_WINDOW = 20;

type WaitingConversationRow = {
  id: string;
  ai_enabled: boolean;
  contact: { sms_opt_out: boolean } | { sms_opt_out: boolean }[] | null;
  messages: { created_at: string; direction: "inbound" | "outbound" }[] | null;
};

/** One batched read for every waiting conversation (at most WAITING_REPLY_CAP - 1 of them): its AI flag, its contact's opt-out, and its newest messages. */
async function readWaitingConversations(supabase: SupabaseClient, organizationId: string, conversationIds: string[]): Promise<Map<string, WaitingConversationState>> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, ai_enabled, contact:contacts(sms_opt_out), messages(created_at, direction)")
    .eq("organization_id", organizationId)
    .in("id", conversationIds)
    .order("created_at", { referencedTable: "messages", ascending: false })
    .limit(WAITING_MESSAGE_WINDOW, { referencedTable: "messages" });
  const states = new Map<string, WaitingConversationState>();
  if (error || !data) return states;
  for (const row of data as WaitingConversationRow[]) {
    const contact = Array.isArray(row.contact) ? (row.contact[0] ?? null) : row.contact;
    states.set(row.id, {
      aiEnabled: row.ai_enabled === true,
      // No contact row means Trackpr cannot reach anyone - treated like opted out.
      smsOptOut: contact ? contact.sms_opt_out !== false : true,
      firstUnansweredInboundAt: firstUnansweredInboundAt(row.messages ?? []),
    });
  }
  return states;
}

/**
 * Resolves the DecisionContext for one Today render. Pass the attention
 * items getDashboardSqlData already loaded: the waiting conversations come
 * from them, never from a second detection pass. The AI settings, business
 * hours and conversation reads only happen when there is a waiting
 * conversation the grace period could apply to.
 */
export async function getDecisionContext(
  supabase: SupabaseClient,
  organizationId: string,
  input: { attentionItems: AttentionItem[]; timeZone: string | null; now?: number },
): Promise<DecisionContext> {
  const now = input.now ?? Date.now();
  const waitingIds = [...new Set(input.attentionItems.filter((item) => item.kind === "awaiting_reply" && item.conversationId).map((item) => item.conversationId as string))];
  const waitingCapReached = waitingIds.length >= WAITING_REPLY_CAP;
  const graceCandidates = waitingCapReached ? [] : waitingIds;

  const [organizationState, settings, aiSettings, waitingConversations] = await Promise.all([
    getOrganizationAutomationState(supabase, organizationId),
    getOrganizationAutomationSettings(supabase, organizationId),
    graceCandidates.length > 0 ? getAiSettings(supabase, organizationId) : Promise.resolve(null),
    graceCandidates.length > 0 ? readWaitingConversations(supabase, organizationId, graceCandidates) : Promise.resolve(new Map<string, WaitingConversationState>()),
  ]);

  const inboundReplyConfig = readInboundCustomerReplyConfig(settings.configById.get("inbound-customer-reply") ?? null);
  const inboundReplyWithinHours =
    graceCandidates.length > 0 && inboundReplyConfig.respect_business_hours
      ? isWithinBusinessHours(new Date(now), input.timeZone ?? "UTC", await getBusinessHours(supabase, organizationId))
      : true;

  return {
    now,
    organizationEligible: organizationEligibleForAutomation(organizationState),
    aiSettingsEnabled: aiSettings?.ai_enabled === true,
    inboundReplyEnabled: automationEnabled(settings, "inbound-customer-reply"),
    estimateFollowupEnabled: automationEnabled(settings, "estimate-followup"),
    inboundReplyWithinHours,
    waitingCapReached,
    waitingConversations,
  };
}
