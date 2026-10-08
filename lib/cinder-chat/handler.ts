import { NextResponse } from "next/server";
import { parseConversation } from "./conversation";
import { isQualified, noopChatLeadSink, type ChatLeadSink } from "./lead-capture";
import { clientKeyFrom, createRateLimiter } from "./rate-limit";
import { generateChatReply, type ChatDeps } from "./service";

/**
 * The Cinder website assistant's HTTP handler (app/api/cinder/chat/route.ts).
 *
 * The endpoint is public (every /api/ path is public in
 * lib/supabase/middleware.ts), so it is bounded on every side: same-origin
 * browsers only, a small body, a validated and windowed transcript, a
 * per-client rate limit, and a model call that can only return text and a
 * next-step key. It reads and writes no Trackpr data and holds no state
 * between requests.
 *
 * Errors never carry provider detail: the browser gets a short code and
 * shows its own friendly fallback.
 */

const MAX_BODY_BYTES = 64 * 1024;
const allow = createRateLimiter();

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** A browser on another site may not drive this endpoint. Requests without an Origin header (server tools) are allowed through to the other limits. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function handleChat(request: Request, deps: ChatDeps & { leadSink?: ChatLeadSink; allow?: (key: string) => boolean } = {}) {
  if (!sameOrigin(request)) return json(403, { error: "forbidden" });
  if (!(deps.allow ?? allow)(clientKeyFrom(request.headers))) return json(429, { error: "rate_limited" });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const conversation = parseConversation(body);
  if (!conversation.ok) return json(400, { error: "invalid_request" });

  const result = await generateChatReply(conversation.turns, deps);
  if (!result.ok) {
    // Operator signal only: the reason code and upstream status, never message text or the visitor's words.
    console.error("[cinder-chat] reply unavailable", { reason: result.reason, status: result.status ?? null });
    return json(503, { error: "unavailable" });
  }

  const { reply, nextStep, intent, signals } = result.value;
  const summary = { intent, signals, nextStepOffered: nextStep !== null };
  if (isQualified(summary)) {
    try {
      await (deps.leadSink ?? noopChatLeadSink).record(summary);
    } catch {
      // Lead capture is best-effort and never blocks the visitor's reply.
    }
  }

  return json(200, { reply, nextStep: nextStep ? { key: nextStep.key, label: nextStep.label, href: nextStep.href } : null, intent, signals });
}

