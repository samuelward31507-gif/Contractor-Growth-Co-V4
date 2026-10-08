/**
 * The Cinder website assistant's conversation state - pure, so every
 * transition is testable without a browser.
 */
export type ChatNextStep = { key: string; label: string; href: string };
export type ChatMessage = { id: string; role: "user" | "assistant"; content: string; nextStep?: ChatNextStep | null };
export type ChatStatus = "idle" | "loading" | "error";

export type ChatState = { open: boolean; messages: ChatMessage[]; status: ChatStatus };

export type ChatAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "send"; message: ChatMessage }
  | { type: "receive"; message: ChatMessage }
  | { type: "fail" }
  | { type: "retry" }
  | { type: "reset" }
  | { type: "restore"; messages: ChatMessage[] };

export const WELCOME =
  "Hi, I'm Cinder's assistant. Ask me anything about Cinder or Trackpr — or tell me a little about your business and I'll help you figure out if it's a fit.";

export const SUGGESTED_PROMPTS = ["What does Cinder actually do?", "How does Trackpr work?", "Would this work for my business?", "I want to see if this is a fit"] as const;

export const FALLBACK_ERROR = "Looks like I'm having trouble connecting right now. You can still use the site to learn about Cinder or get in touch with the team.";

/** Mirrors the server's limit (lib/cinder-chat/conversation.ts). */
export const MAX_INPUT_CHARS = 1000;
/** What a session keeps (and sends) - the server windows it further. */
export const MAX_STORED_MESSAGES = 40;

export const INITIAL_STATE: ChatState = { open: false, messages: [], status: "idle" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false };
    case "send":
      if (state.status === "loading") return state;
      return { ...state, status: "loading", messages: [...state.messages, action.message].slice(-MAX_STORED_MESSAGES) };
    case "receive":
      return { ...state, status: "idle", messages: [...state.messages, action.message].slice(-MAX_STORED_MESSAGES) };
    case "fail":
      return { ...state, status: "error" };
    case "retry":
      return state.status === "error" && lastUserMessage(state) ? { ...state, status: "loading" } : state;
    case "reset":
      return { ...INITIAL_STATE, open: state.open };
    case "restore":
      return { ...state, messages: sanitizeStored(action.messages) };
  }
}

export function lastUserMessage(state: ChatState): ChatMessage | null {
  const last = state.messages[state.messages.length - 1];
  return last && last.role === "user" ? last : null;
}

/** The transcript the server receives: role and text only (never ids or buttons). */
export function toRequestMessages(messages: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

export function userMessageCount(messages: ChatMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

/** Anything read back from storage is untrusted: keep only well-formed messages, and only same-site button links. */
export function sanitizeStored(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { id, role, content, nextStep } = item as Record<string, unknown>;
    if (typeof id !== "string" || (role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) continue;
    const step = nextStep as Record<string, unknown> | null | undefined;
    const safeStep =
      step && typeof step.key === "string" && typeof step.label === "string" && typeof step.href === "string" && isSiteHref(step.href) ? { key: step.key, label: step.label, href: step.href } : null;
    messages.push({ id, role, content: content.slice(0, 4000), nextStep: safeStep });
  }
  // A transcript always starts with the visitor and alternates; drop a trailing unanswered message (it is re-asked, not resent).
  while (messages.length && messages[messages.length - 1].role === "user") messages.pop();
  return messages.slice(-MAX_STORED_MESSAGES);
}

/** The site's own pages and its mailto hand-off - the only destinations next steps use. */
export function isSiteHref(href: string): boolean {
  return (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("mailto:");
}
