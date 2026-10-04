import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttentionItem } from "@/lib/dashboard/queries";
import { getAutomationDefaultEnabled } from "@/lib/automation/catalog";
import { readEstimateFollowupConfig, readInboundCustomerReplyConfig } from "@/lib/automation/settings";
import { isWithinBusinessHours } from "@/lib/automation/outbound-gate";
import { getAiSettings, getBusinessHours } from "@/lib/settings/queries";
import { getOpenOpportunitiesResult, type OpenOpportunitiesResult } from "@/lib/opportunities/queries";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { WAITING_EVIDENCE_FILTER } from "@/lib/conversations/waiting";
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
  messages: { created_at: string; direction: "inbound" | "outbound"; status: string | null }[] | null;
};

/** One batched read for every waiting conversation (at most WAITING_REPLY_CAP of them - the dashboard SQL returns no more): its AI flag, its contact's opt-out, and its newest messages. */
async function readWaitingConversations(supabase: SupabaseClient, organizationId: string, conversationIds: string[]): Promise<Map<string, WaitingConversationState>> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, ai_enabled, contact:contacts(sms_opt_out), messages(created_at, direction, status)")
    .eq("organization_id", organizationId)
    .in("id", conversationIds)
    // Phase 3 (W1): only inbound and successful outbound messages fill the window - failed sends and notes are not replies.
    .or(WAITING_EVIDENCE_FILTER, { referencedTable: "messages" })
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
 * Phase 2-4 (K2, K6a): the pending-estimate contacts whose open SMS
 * conversation has AI turned off. The contacts come from the request-cached
 * open-opportunities read Today already makes - no extra opportunities
 * read - and the conversation read is skipped entirely when there are no
 * pending estimates. One paged read of the organization's AI-off open SMS
 * conversations (typically few), intersected in memory - never an id list,
 * never one read per estimate. A failed read fails closed: every pending
 * estimate's contact is treated as unreachable, so those estimates are human.
 */
/**
 * Phase 2-11 (G4): per contact, the latest successful (sent or delivered)
 * outbound message - only read when an open pending estimate is past its
 * follow-up window (72h, or the configured one - R-d), so a missed estimate follow-up can be told apart from one that
 * was followed up (by a person or by Trackpr's own automated follow-up).
 * One paged read of the organization's conversations that hold a successful
 * outbound message, with the newest one embedded - the same shape as the
 * uncontacted-lead detector's evidence read. Never an id list, never one
 * read per estimate. A failed read returns null: nothing is labelled missed.
 */
async function readLatestOutboundByContact(supabase: SupabaseClient, organizationId: string, opportunities: OpenOpportunitiesResult, now: number, windowMs: number): Promise<Map<string, number> | null> {
  const anyEstimatePastWindow = opportunities.data.some((opportunity) => {
    if (opportunity.type !== "pending_estimate" || typeof opportunity.metadata.sent_at !== "string") return false;
    const sentMs = new Date(opportunity.metadata.sent_at).getTime();
    return !Number.isNaN(sentMs) && now - sentMs >= windowMs;
  });
  if (!anyEstimatePastWindow) return new Map();
  const read = await readAllPages<{ contact_id: string | null; messages: { created_at: string }[] | null }>(() =>
    supabase
      .from("conversations")
      .select("contact_id, messages!inner(created_at)")
      .eq("organization_id", organizationId)
      .not("contact_id", "is", null)
      .eq("messages.organization_id", organizationId)
      .eq("messages.direction", "outbound")
      .in("messages.status", ["sent", "delivered"])
      .order("created_at", { referencedTable: "messages", ascending: false })
      .limit(1, { referencedTable: "messages" })
      .order("id"),
  );
  if (read.failed) return null;
  const latest = new Map<string, number>();
  for (const row of read.rows) {
    const createdMs = row.messages?.[0] ? new Date(row.messages[0].created_at).getTime() : Number.NaN;
    if (!row.contact_id || Number.isNaN(createdMs)) continue;
    if (createdMs > (latest.get(row.contact_id) ?? Number.NEGATIVE_INFINITY)) latest.set(row.contact_id, createdMs);
  }
  return latest;
}

async function readEstimateContactsWithAiDisabled(supabase: SupabaseClient, organizationId: string, opportunities: OpenOpportunitiesResult): Promise<Set<string>> {
  const estimateContactIds = new Set(opportunities.data.filter((opportunity) => opportunity.type === "pending_estimate" && opportunity.contactId).map((opportunity) => opportunity.contactId as string));
  if (estimateContactIds.size === 0) return new Set();
  const read = await readAllPages<{ contact_id: string }>(() =>
    supabase.from("conversations").select("contact_id").eq("organization_id", organizationId).eq("status", "open").eq("channel", "sms").eq("ai_enabled", false).not("contact_id", "is", null).order("id"),
  );
  if (read.failed) return estimateContactIds;
  return new Set(read.rows.map((row) => row.contact_id).filter((contactId) => estimateContactIds.has(contactId)));
}

/** The two estimate reads (Phase 2-4 AI-off contacts, Phase 2-11 latest outbound), both from one request-cached open-opportunities read. */
async function readEstimateContext(supabase: SupabaseClient, organizationId: string, now: number, windowMs: Promise<number>): Promise<[Set<string>, Map<string, number> | null]> {
  const opportunities = await getOpenOpportunitiesResult(supabase, organizationId);
  // The settings read was started alongside this one; it is already in flight.
  const window = await windowMs;
  return Promise.all([readEstimateContactsWithAiDisabled(supabase, organizationId, opportunities), readLatestOutboundByContact(supabase, organizationId, opportunities, now, window)]);
}

/**
 * Phase 2-13 (R-d): the organization's estimate follow-up window - the
 * configured followup_2_hours, read with the automation's own lenient reader
 * (invalid or missing config falls back to the 24h/72h defaults, exactly as
 * the automation does), so Today and the automation agree on when Trackpr's
 * last touch is due.
 */
export function estimateFollowupWindowMsFromSettings(settings: OrganizationAutomationSettings): number {
  return readEstimateFollowupConfig(settings.configById.get("estimate-followup") ?? null).followup_2_hours * 60 * 60 * 1000;
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

  // Phase 2-11 (G3): the waiting conversations are read even when the cap is
  // reached (still at most the 5 the SQL returns), so a reply waiting 4h or
  // more can be shown as a missed follow-up. The actor rules are unchanged:
  // at the cap every waiting item is still human (resolveSignalActor checks
  // waitingCapReached first), and the AI-settings read stays grace-only.
  const settingsRead = getOrganizationAutomationSettings(supabase, organizationId);
  const [organizationState, settings, aiSettings, waitingConversations, [estimateContactAiDisabled, latestOutboundMsByContact]] = await Promise.all([
    getOrganizationAutomationState(supabase, organizationId),
    settingsRead,
    graceCandidates.length > 0 ? getAiSettings(supabase, organizationId) : Promise.resolve(null),
    waitingIds.length > 0 ? readWaitingConversations(supabase, organizationId, waitingIds) : Promise.resolve(new Map<string, WaitingConversationState>()),
    readEstimateContext(supabase, organizationId, now, settingsRead.then(estimateFollowupWindowMsFromSettings)),
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
    estimateContactAiDisabled,
    latestOutboundMsByContact,
    estimateFollowupWindowMs: estimateFollowupWindowMsFromSettings(settings),
  };
}
