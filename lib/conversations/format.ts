import { isSameCalendarDay } from "@/lib/appointments/format";
import type { ConversationChannel, ConversationStatus, MessageDirection, MessageSenderType } from "./queries";
import { STATUS_DOT_TONE_CLASS } from "@/lib/ui/status-vocabulary";

export const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  sms: "SMS",
  voice: "Voice",
  email: "Email",
  web: "Web",
};

export const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Open",
  closed: "Closed",
};

// Rendered as a small dot next to plain text (see status-badge.tsx), not a
// filled pill - consistent with the Leads/Appointments dot convention.
export const STATUS_DOT_CLASS: Record<ConversationStatus, string> = {
  open: STATUS_DOT_TONE_CLASS.success,
  closed: STATUS_DOT_TONE_CLASS.muted,
};

// Labels for who authored a message. There is no per-user identity on
// messages (no user_id column), so a staff-authored message is always
// generically "You" - that's what the schema actually supports.
// Batch 3: an AI-sent message is Trackpr talking for the business - named
// as such ("Trackpr"), never as the machinery behind it ("AI").
export const SENDER_LABELS: Record<MessageSenderType, string> = {
  customer: "Customer",
  ai: "Trackpr",
  user: "You",
  system: "System",
};

export const SENDER_INITIALS: Record<MessageSenderType, string> = {
  customer: "C",
  ai: "T",
  user: "Y",
  system: "S",
};

export const SENDER_AVATAR_CLASS: Record<MessageSenderType, string> = {
  customer: "bg-ink-3",
  ai: "bg-brand-strong",
  user: "bg-ink",
  system: STATUS_DOT_TONE_CLASS.neutral,
};

export const DIRECTION_LABELS: Record<MessageDirection, string> = {
  inbound: "Inbound",
  outbound: "Outbound",
};

export function formatMessageTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatConversationDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Date-divider label for the message thread, consistent with the
 * Today/Yesterday convention already used for Appointments' day grouping.
 */
export function getMessageDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (isSameCalendarDay(date, now)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return "Yesterday";

  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}
