import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import type { Contact } from "@/lib/contacts/queries";
import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";

export type ConversationChannel = "sms" | "voice" | "email" | "web";
export type ConversationStatus = "open" | "closed";
export type MessageDirection = "inbound" | "outbound";
export type MessageSenderType = "customer" | "ai" | "user" | "system";

export const CONVERSATION_CHANNELS: { value: ConversationChannel; label: string }[] = [
  { value: "sms", label: "SMS" },
  { value: "voice", label: "Voice" },
  { value: "email", label: "Email" },
  { value: "web", label: "Web" },
];

export const CONVERSATION_STATUSES: { value: ConversationStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
];

export type ConversationContact = Pick<
  Contact,
  "id" | "first_name" | "last_name" | "company_name" | "phone" | "email"
>;

export type ConversationLead = {
  id: string;
  service: string | null;
  source: string | null;
  status: LeadStatus;
  temperature: LeadTemperature;
  estimated_value: number | null;
};

export type MessageStatus = "queued" | "sent" | "delivered" | "failed" | "undelivered" | "received" | "logged";

export type Message = {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  sender_type: MessageSenderType;
  body: string;
  status: MessageStatus;
  status_reason: string | null;
  provider_error_code: string | null;
  provider_message_id: string | null;
  workflow_execution_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Conversation = {
  id: string;
  contact_id: string | null;
  lead_id: string | null;
  channel: ConversationChannel;
  status: ConversationStatus;
  ai_enabled: boolean;
  created_at: string;
  updated_at: string;
  contact: ConversationContact | null;
  lead: ConversationLead | null;
};

export type ConversationWithLastMessage = Conversation & {
  lastMessage: Message | null;
  // max(conversation.updated_at, lastMessage.created_at) - inserting a
  // message never touches the conversation row (no DB trigger does this),
  // so relying on updated_at alone would understate real activity.
  lastActivityAt: string;
};

// Single string literals (not `+` concatenation) - Supabase's type-level
// select parser needs the literal type to infer typed columns.
const CONVERSATION_COLUMNS =
  "id, contact_id, lead_id, channel, status, ai_enabled, created_at, updated_at, contact:contacts(id, first_name, last_name, company_name, phone, email), lead:leads(id, service, source, status, temperature, estimated_value)";

const MESSAGE_COLUMNS =
  "id, conversation_id, direction, sender_type, body, status, status_reason, provider_error_code, provider_message_id, workflow_execution_id, created_at, updated_at";

type Embedded<T> = T | T[] | null;

function one<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

type RawConversationRow = Omit<Conversation, "contact" | "lead"> & {
  contact: Embedded<ConversationContact>;
  lead: Embedded<ConversationLead>;
};

function normalizeConversation(row: RawConversationRow): Conversation {
  return { ...row, contact: one(row.contact), lead: one(row.lead) };
}

/**
 * Loads every conversation for the org (capped, matching the
 * Contacts/Leads/Appointments pattern), with its contact and lead embedded
 * via the existing foreign keys. RLS already scopes rows to the caller's
 * organization; the explicit filter keeps the query efficient and its
 * intent obvious.
 */
export async function getConversations(supabase: SupabaseClient, organizationId: string): Promise<Conversation[]> {
  const { data } = await supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false })
    .limit(500);

  return ((data ?? []) as RawConversationRow[]).map(normalizeConversation);
}

/**
 * The messages table has no per-conversation "last message" query available
 * without a window-function RPC (out of scope - no schema/function changes
 * allowed). Instead this loads the org's recent messages once, newest
 * first, and reduces to one entry per conversation in memory - the same
 * "fetch capped, derive in JS" approach already used by the dashboard.
 */
export async function getLastMessagesByConversation(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Map<string, Message>> {
  const { data } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(2000);

  const map = new Map<string, Message>();
  for (const message of (data ?? []) as Message[]) {
    if (!map.has(message.conversation_id)) {
      map.set(message.conversation_id, message);
    }
  }
  return map;
}

/**
 * Combines conversations with their last message and derives a real
 * "last activity" timestamp, sorted most-recently-active first.
 */
export function attachLastMessages(
  conversations: Conversation[],
  lastMessages: Map<string, Message>,
): ConversationWithLastMessage[] {
  const withActivity = conversations.map((conversation) => {
    const lastMessage = lastMessages.get(conversation.id) ?? null;
    const lastActivityAt =
      lastMessage && new Date(lastMessage.created_at).getTime() > new Date(conversation.updated_at).getTime()
        ? lastMessage.created_at
        : conversation.updated_at;
    return { ...conversation, lastMessage, lastActivityAt };
  });

  return withActivity.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
}

/**
 * Loads a single conversation scoped to the org. Any error - including an
 * invalid UUID in `id`, a nonexistent conversation, or one belonging to a
 * different organization - resolves to `null` rather than throwing, so
 * callers can render a clean "not found" state instead of a crash.
 */
export async function getConversation(
  supabase: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return normalizeConversation(data as RawConversationRow);
}

/**
 * Loads every message in a conversation, oldest first (thread reading
 * order). Scoped to the org as well as the conversation id - defense in
 * depth alongside RLS.
 */
export async function getMessages(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<Message[]> {
  const { data } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(1000);

  return (data ?? []) as Message[];
}

export type ConversationFilters = {
  query?: string;
  channel?: ConversationChannel | "all";
  status?: ConversationStatus | "all";
};

/**
 * Filters an already-fetched, org-scoped conversation list in memory. A
 * plain ilike/or() query can't match a combined contact full name against
 * separately-stored first/last columns, so search happens here over real
 * data rather than a fragile multi-column OR query.
 */
export function filterConversations(
  conversations: ConversationWithLastMessage[],
  filters: ConversationFilters,
): ConversationWithLastMessage[] {
  const term = filters.query?.trim().toLowerCase() ?? "";

  return conversations.filter((conversation) => {
    if (filters.channel && filters.channel !== "all" && conversation.channel !== filters.channel) {
      return false;
    }
    if (filters.status && filters.status !== "all" && conversation.status !== filters.status) {
      return false;
    }

    if (!term) return true;

    const contact = conversation.contact;
    const fullName = contact
      ? [contact.first_name, contact.last_name].filter(Boolean).join(" ").toLowerCase()
      : "";
    const haystacks = [
      fullName,
      contact?.first_name?.toLowerCase(),
      contact?.last_name?.toLowerCase(),
      contact?.phone?.toLowerCase(),
      contact?.email?.toLowerCase(),
      contact?.company_name?.toLowerCase(),
      conversation.channel,
      conversation.lead?.service?.toLowerCase(),
    ];
    return haystacks.some((value) => value?.includes(term));
  });
}

export type RelevantAppointment = {
  id: string;
  title: string;
  start_at: string;
  status: AppointmentStatus;
};

/**
 * Loads the contact's appointments (existing `appointments.contact_id` FK -
 * no new relationship) so the conversation context panel can surface the
 * most relevant one without a dedicated conversations<->appointments link.
 */
export async function getContactAppointments(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<RelevantAppointment[]> {
  const { data } = await supabase
    .from("appointments")
    .select("id, title, start_at, status")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("start_at", { ascending: true })
    .limit(50);

  return (data ?? []) as RelevantAppointment[];
}

/**
 * Picks the single most useful appointment to surface: the soonest upcoming
 * one if there is one, otherwise the most recent past one.
 */
export function pickRelevantAppointment(
  appointments: RelevantAppointment[],
  now: Date = new Date(),
): RelevantAppointment | null {
  const upcoming = appointments.filter((appointment) => new Date(appointment.start_at).getTime() >= now.getTime());
  if (upcoming.length > 0) return upcoming[0];
  if (appointments.length === 0) return null;
  return appointments[appointments.length - 1];
}

export type ConversationSummary = {
  total: number;
  open: number;
  closed: number;
  aiEnabled: number;
};

export function summarizeConversations(conversations: Conversation[]): ConversationSummary {
  return {
    total: conversations.length,
    open: conversations.filter((conversation) => conversation.status === "open").length,
    closed: conversations.filter((conversation) => conversation.status === "closed").length,
    aiEnabled: conversations.filter((conversation) => conversation.ai_enabled).length,
  };
}

/**
 * Returns the contact's existing open conversation on this channel, or opens
 * a new one. Relies on the partial unique index
 * (organization_id, contact_id, channel) where status = 'open' to make a
 * concurrent race (two inbound messages arriving at once) resolve safely:
 * the loser's insert hits the unique violation and this re-selects the
 * winner's row instead of erroring. Works with either an RLS-scoped
 * user-session client or a service-role client - both already enforce
 * organization scoping the same way every other query in this codebase does
 * (explicit filter + trusted organizationId from the caller).
 */
export async function findOrCreateOpenConversation(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  channel: ConversationChannel,
  leadId: string | null = null,
): Promise<{ id: string } | null> {
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .eq("status", "open")
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ organization_id: organizationId, contact_id: contactId, channel, lead_id: leadId })
    .select("id")
    .single();

  if (created) return created;

  // Unique-violation race: someone else's insert won between our select and
  // our insert. Re-select rather than treat this as a failure.
  if (error?.code === "23505") {
    const { data: winner } = await supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .eq("channel", channel)
      .eq("status", "open")
      .maybeSingle();
    return winner ?? null;
  }

  return null;
}
