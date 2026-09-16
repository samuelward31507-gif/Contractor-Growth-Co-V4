import { isSameCalendarDay } from "@/lib/appointments/format";
import type { ConversationChannel, ConversationStatus, MessageDirection, MessageSenderType } from "./queries";

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

export const STATUS_BADGE_CLASS: Record<ConversationStatus, string> = {
  open: "bg-emerald-50 text-emerald-700",
  closed: "bg-slate-100 text-slate-500",
};

// Labels for who authored a message. There is no per-user identity on
// messages (no user_id column), so a staff-authored message is always
// generically "You" - that's what the schema actually supports.
export const SENDER_LABELS: Record<MessageSenderType, string> = {
  customer: "Customer",
  ai: "AI",
  user: "You",
  system: "System",
};

export const SENDER_INITIALS: Record<MessageSenderType, string> = {
  customer: "C",
  ai: "AI",
  user: "Y",
  system: "S",
};

export const SENDER_AVATAR_CLASS: Record<MessageSenderType, string> = {
  customer: "bg-slate-700",
  ai: "bg-blue-600",
  user: "bg-slate-900",
  system: "bg-slate-400",
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
