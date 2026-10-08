/**
 * Website assistant analytics - an event boundary, not a vendor.
 *
 * The site has no analytics tool installed and this feature does not add
 * one. Each event is dispatched on window as a "cinder:chat" CustomEvent
 * (and nothing leaves the browser), so whatever analytics the site adopts
 * later can subscribe in one place. Events carry names and small
 * categorical properties only - never message text or anything a visitor
 * typed.
 */
export const CHAT_EVENT = "cinder:chat";

export type ChatEventName =
  | "opened"
  | "first_message"
  | "suggested_prompt_selected"
  | "meaningful_conversation"
  | "qualification_signal"
  | "meeting_cta_shown"
  | "meeting_cta_clicked"
  | "conversation_ended"
  | "reply_failed";

export type ChatEventDetail = { name: ChatEventName; properties?: Record<string, string | number | boolean> };

export function trackChatEvent(name: ChatEventName, properties?: ChatEventDetail["properties"]): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent<ChatEventDetail>(CHAT_EVENT, { detail: { name, properties } }));
  } catch {
    // Analytics never interferes with the conversation.
  }
}
