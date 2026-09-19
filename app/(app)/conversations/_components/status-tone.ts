import type { BadgeTone } from "@/lib/ui/badge";
import type { ConversationStatus, MessageStatus } from "@/lib/conversations/queries";

/**
 * Maps the conversation/message domain's own status enums onto the shared
 * Badge primitive's 5-tone palette (lib/ui/badge.tsx) - kept here rather
 * than in lib/conversations/format.ts, which is a read-only reference for
 * this redesign pass, not a file this cluster is allowed to edit.
 */
export const CONVERSATION_STATUS_TONE: Record<ConversationStatus, BadgeTone> = {
  open: "success",
  closed: "neutral",
};

// Delivery status for an outbound message (from us to the customer). Inbound
// messages don't get one of these shown - "delivered"/"failed" only means
// something for something *we* sent.
export const MESSAGE_STATUS_TONE: Record<MessageStatus, BadgeTone> = {
  queued: "neutral",
  sent: "neutral",
  delivered: "success",
  failed: "danger",
  undelivered: "danger",
  received: "neutral",
  logged: "neutral",
};

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  queued: "Sending…",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Not delivered",
  undelivered: "Not delivered",
  received: "Received",
  logged: "Logged only",
};
