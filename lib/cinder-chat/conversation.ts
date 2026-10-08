/**
 * The conversation a visitor's browser sends, validated and bounded before
 * any of it reaches the model. The browser holds the transcript; the
 * server keeps nothing between requests.
 */
export type ChatRole = "user" | "assistant";
export type ChatTurn = { role: ChatRole; content: string };

/** The longest visitor message accepted (the input enforces the same limit). */
export const MAX_USER_MESSAGE_CHARS = 1000;
/** Earlier assistant replies are trimmed to this before being sent back. */
export const MAX_ASSISTANT_MESSAGE_CHARS = 1500;
/** Only the most recent turns are sent to the model. */
export const MAX_TURNS_SENT = 16;
/** A hard ceiling on what a request may carry at all. */
export const MAX_TURNS_ACCEPTED = 80;

export type ParsedConversation = { ok: true; turns: ChatTurn[] } | { ok: false; error: string };

function isTurn(value: unknown): value is { role: unknown; content: unknown } {
  return typeof value === "object" && value !== null && "role" in value && "content" in value;
}

/**
 * Accepts `{ messages: [{ role, content }, ...] }`. Returns the window the
 * model sees: at most MAX_TURNS_SENT turns, starting with a visitor turn,
 * strictly alternating, ending with the visitor's new message.
 */
export function parseConversation(body: unknown): ParsedConversation {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { messages?: unknown }).messages)) return { ok: false, error: "messages must be an array" };
  const raw = (body as { messages: unknown[] }).messages;
  if (raw.length === 0 || raw.length > MAX_TURNS_ACCEPTED) return { ok: false, error: "message count out of range" };

  const turns: ChatTurn[] = [];
  for (const item of raw) {
    if (!isTurn(item) || (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") return { ok: false, error: "malformed message" };
    const content = item.content.trim();
    if (!content) return { ok: false, error: "empty message" };
    if (item.role === "user" && content.length > MAX_USER_MESSAGE_CHARS) return { ok: false, error: "message too long" };
    turns.push({ role: item.role, content: item.role === "assistant" ? content.slice(0, MAX_ASSISTANT_MESSAGE_CHARS) : content });
  }

  if (turns[turns.length - 1].role !== "user") return { ok: false, error: "the last message must be the visitor's" };
  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i].role === turns[i - 1].role) return { ok: false, error: "messages must alternate" };
  }

  let window = turns.slice(-MAX_TURNS_SENT);
  // The welcome message (and any window cut) can leave an assistant turn first; the model's history starts with the visitor.
  while (window.length > 0 && window[0].role !== "user") window = window.slice(1);
  return { ok: true, turns: window };
}
