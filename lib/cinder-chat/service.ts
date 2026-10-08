/**
 * The Cinder website assistant's one model call - server-side only.
 *
 * Reuses the Anthropic SDK this repository already depends on
 * (lib/bi/insights.ts) and the same ANTHROPIC_API_KEY server environment
 * variable. One request in, one structured reply out: no tools, no loops,
 * nothing the model writes is ever executed or fetched. The reply text is
 * checked (guards.ts) and the next-step button is resolved from a fixed
 * list (actions.ts) before anything reaches the browser.
 */
import Anthropic from "@anthropic-ai/sdk";
import { resolveNextStep, type NextStepLink } from "./actions";
import type { ChatTurn } from "./conversation";
import { guardReply } from "./guards";
import { INTENTS, REPLY_SCHEMA, SIGNALS, SYSTEM_PROMPT, type ChatIntent, type QualificationSignal } from "./prompt";

export const CHAT_MODEL = "claude-opus-5-5";
/** Room for adaptive thinking at low effort plus a short JSON reply. */
const MAX_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 1;

export const REFUSAL_REPLY = "That's not something I can help with here, but I'm happy to answer questions about Cinder and Trackpr.";

export type ChatReply = { reply: string; nextStep: NextStepLink | null; intent: ChatIntent; signals: QualificationSignal[] };

export type ChatFailureReason = "not_configured" | "rate_limited" | "timeout" | "connection" | "provider_error" | "incomplete" | "unparseable";
export type ChatResult = { ok: true; value: ChatReply; guarded: boolean } | { ok: false; reason: ChatFailureReason; status?: number };

type CreateMessage = (params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions) => Promise<Anthropic.Beta.Messages.BetaMessage>;

export type ChatDeps = {
  /** Injected in tests; defaults to a real client built from ANTHROPIC_API_KEY. */
  createMessage?: CreateMessage;
  apiKey?: string | undefined;
};

export function buildRequest(turns: ChatTurn[]): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: CHAT_MODEL,
    max_tokens: MAX_TOKENS,
    // The rules + knowledge are one frozen system prompt; automatic caching reuses it across visitors.
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    // A chat route: low effort answers well and fast.
    output_config: { effort: "low", format: { type: "json_schema", schema: REPLY_SCHEMA as unknown as Record<string, unknown> } },
    // On a policy decline the API retries on a suitable model inside the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
  };
}

/** Validates the model's JSON field by field; anything off-contract is dropped or defaulted, never trusted. */
export function parseReply(text: string): { reply: string; nextStep: NextStepLink | null; intent: ChatIntent; signals: QualificationSignal[] } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.reply !== "string" || !record.reply.trim()) return null;
  const intent = (INTENTS as readonly string[]).includes(record.intent as string) ? (record.intent as ChatIntent) : "browsing";
  const signals = Array.isArray(record.signals) ? [...new Set(record.signals.filter((s): s is QualificationSignal => (SIGNALS as readonly string[]).includes(s as string)))] : [];
  return { reply: record.reply.trim(), nextStep: resolveNextStep(record.next_step), intent, signals };
}

function failureFrom(error: unknown): ChatResult {
  if (error instanceof Anthropic.RateLimitError) return { ok: false, reason: "rate_limited", status: 429 };
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, reason: "timeout" };
  if (error instanceof Anthropic.APIConnectionError) return { ok: false, reason: "connection" };
  if (error instanceof Anthropic.APIError) return { ok: false, reason: "provider_error", status: error.status };
  return { ok: false, reason: "provider_error" };
}

export async function generateChatReply(turns: ChatTurn[], deps: ChatDeps = {}): Promise<ChatResult> {
  const apiKey = "apiKey" in deps ? deps.apiKey : process.env.ANTHROPIC_API_KEY;
  let createMessage = deps.createMessage;
  if (!createMessage) {
    if (!apiKey) return { ok: false, reason: "not_configured" };
    const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    createMessage = (params, options) => client.beta.messages.create(params, options);
  }

  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    message = await createMessage(buildRequest(turns), { timeout: REQUEST_TIMEOUT_MS });
  } catch (error) {
    return failureFrom(error);
  }

  if (message.stop_reason === "refusal") return { ok: true, value: { reply: REFUSAL_REPLY, nextStep: null, intent: "browsing", signals: [] }, guarded: true };
  if (message.stop_reason === "max_tokens") return { ok: false, reason: "incomplete" };

  const text = message.content
    .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const parsed = parseReply(text);
  if (!parsed) return { ok: false, reason: "unparseable" };

  const guarded = guardReply(parsed.reply);
  if (!guarded.reply) return { ok: false, reason: "unparseable" };
  return { ok: true, value: { ...parsed, reply: guarded.reply }, guarded: guarded.replaced };
}
