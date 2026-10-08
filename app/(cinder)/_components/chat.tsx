"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useReducer, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, ArrowUp, MessageCircle, RotateCcw, X } from "lucide-react";
import { CinderMark } from "./logo";
import { trackChatEvent } from "./chat-analytics";
import {
  FALLBACK_ERROR,
  INITIAL_STATE,
  MAX_INPUT_CHARS,
  SUGGESTED_PROMPTS,
  WELCOME,
  chatReducer,
  isSiteHref,
  lastUserMessage,
  sanitizeStored,
  toRequestMessages,
  userMessageCount,
  type ChatMessage,
  type ChatNextStep,
} from "./chat-state";

/**
 * The Cinder website assistant - a floating launcher and conversation
 * panel, mounted once in the Cinder layout so the conversation carries
 * across pages. Replies come from POST /api/cinder/chat (server-side model
 * call); this component never sees a key and never renders model output
 * as HTML.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";
const STORAGE_KEY = "cinder-chat:v1";
const REQUEST_TIMEOUT_MS = 45_000;
/** A conversation counts as meaningful at this many visitor messages. */
const MEANINGFUL_AT = 3;
const MEETING_KEYS = new Set(["get_started", "talk"]);

let idCounter = 0;
const newId = () => `m${Date.now().toString(36)}${(idCounter += 1)}`;

function readStored(): ChatMessage[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeStored(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeStored(messages: ChatMessage[]) {
  try {
    if (messages.length) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the conversation still works for this page view.
  }
}

type ReplyBody = { reply?: unknown; nextStep?: unknown; intent?: unknown; signals?: unknown };

export function CinderChat() {
  const [state, dispatch] = useReducer(chatReducer, INITIAL_STATE);
  const [draft, setDraft] = useState("");
  const [viewport, setViewport] = useState<{ height: number; top: number } | null>(null);
  const titleId = useId();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seenSignals = useRef<Set<string>>(new Set());
  const meaningfulTracked = useRef(false);
  const restored = useRef(false);

  // Restore this tab's conversation once, after hydration.
  useEffect(() => {
    const messages = readStored();
    if (messages.length) dispatch({ type: "restore", messages });
    restored.current = true;
  }, []);

  useEffect(() => {
    if (restored.current) writeStored(state.messages);
  }, [state.messages]);

  // Newest message in view.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.messages, state.status, state.open]);

  // On phones the panel fills the visible viewport, so the input stays above the on-screen keyboard.
  useEffect(() => {
    if (!state.open || typeof window === "undefined" || !window.visualViewport) return;
    const visual = window.visualViewport;
    const update = () => setViewport({ height: visual.height, top: visual.offsetTop });
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, [state.open]);

  // Phones: the page behind a full-screen panel does not scroll.
  useEffect(() => {
    if (!state.open || !window.matchMedia("(max-width: 639px)").matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [state.open]);

  useEffect(() => {
    if (state.open) inputRef.current?.focus();
  }, [state.open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const request = useCallback(async (history: ChatMessage[]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/cinder/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: toRequestMessages(history) }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as ReplyBody;
      if (!response.ok || typeof body.reply !== "string" || !body.reply.trim()) throw new Error("unavailable");

      const step = body.nextStep as ChatNextStep | null | undefined;
      const nextStep = step && typeof step.href === "string" && typeof step.label === "string" && isSiteHref(step.href) ? { key: String(step.key), label: step.label, href: step.href } : null;
      dispatch({ type: "receive", message: { id: newId(), role: "assistant", content: body.reply, nextStep } });

      if (nextStep && MEETING_KEYS.has(nextStep.key)) trackChatEvent("meeting_cta_shown", { key: nextStep.key });
      const intent = typeof body.intent === "string" ? body.intent : "browsing";
      const fresh = (Array.isArray(body.signals) ? body.signals : []).filter((s): s is string => typeof s === "string" && !seenSignals.current.has(s));
      fresh.forEach((s) => seenSignals.current.add(s));
      if (intent !== "browsing" || fresh.length) trackChatEvent("qualification_signal", { intent, newSignals: fresh.length });
    } catch {
      if (controller.signal.aborted && abortRef.current !== controller) return; // superseded by reset or a newer request
      dispatch({ type: "fail" });
      trackChatEvent("reply_failed");
    } finally {
      window.clearTimeout(timer);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const send = useCallback(
    (text: string, source: "typed" | "suggested") => {
      const content = text.trim().slice(0, MAX_INPUT_CHARS);
      if (!content || state.status === "loading") return;
      const message: ChatMessage = { id: newId(), role: "user", content };
      const history = state.status === "error" && lastUserMessage(state) ? [...state.messages.slice(0, -1), message] : [...state.messages, message];
      if (state.status === "error" && lastUserMessage(state)) dispatch({ type: "restore", messages: state.messages.slice(0, -1) });
      dispatch({ type: "send", message });
      setDraft("");

      const count = userMessageCount(history);
      if (count === 1) trackChatEvent("first_message", { source });
      if (source === "suggested") trackChatEvent("suggested_prompt_selected");
      if (count >= MEANINGFUL_AT && !meaningfulTracked.current) {
        meaningfulTracked.current = true;
        trackChatEvent("meaningful_conversation", { messages: count });
      }
      void request(history);
    },
    [request, state],
  );

  const retry = useCallback(() => {
    if (state.status !== "error" || !lastUserMessage(state)) return;
    dispatch({ type: "retry" });
    void request(state.messages);
  }, [request, state]);

  const open = () => {
    dispatch({ type: "open" });
    trackChatEvent("opened", { returning: state.messages.length > 0 });
  };

  const close = useCallback(() => {
    if (state.messages.length) trackChatEvent("conversation_ended", { reason: "closed", messages: userMessageCount(state.messages) });
    dispatch({ type: "close" });
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }, [state.messages]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (state.messages.length) trackChatEvent("conversation_ended", { reason: "reset", messages: userMessageCount(state.messages) });
    seenSignals.current = new Set();
    meaningfulTracked.current = false;
    dispatch({ type: "reset" });
    setDraft("");
    inputRef.current?.focus();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send(draft, "typed");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft, "typed");
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  const loading = state.status === "loading";
  const empty = state.messages.length === 0;

  return (
    <>
      {!state.open ? (
        <button
          ref={launcherRef}
          type="button"
          onClick={open}
          aria-haspopup="dialog"
          aria-label="Ask Cinder - open the website assistant"
          className={`ui-rise fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-[max(1.25rem,env(safe-area-inset-right))] z-30 inline-flex h-12 items-center gap-2 rounded-full bg-cinder-ink px-4 text-[14px] font-medium text-cinder-on-night shadow-[0_8px_24px_rgba(13,21,18,0.18),0_1px_2px_rgba(13,21,18,0.2)] transition-[background-color,transform] duration-200 hover:bg-[#1c2824] motion-safe:hover:-translate-y-0.5 sm:px-5 ${FOCUS}`}
        >
          <MessageCircle className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          <span className="hidden sm:inline">Ask Cinder</span>
        </button>
      ) : null}

      {state.open ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onKeyDown={onPanelKeyDown}
          style={viewport ? ({ "--chat-vh": `${viewport.height}px`, "--chat-top": `${viewport.top}px` } as CSSProperties) : undefined}
          className="ui-rise fixed inset-x-0 top-[var(--chat-top,0px)] z-50 flex h-[var(--chat-vh,100dvh)] flex-col overflow-hidden bg-cinder-canvas text-cinder-ink sm:inset-auto sm:top-auto sm:bottom-5 sm:right-5 sm:h-[min(640px,calc(100dvh-2.5rem))] sm:w-[400px] sm:rounded-[24px] sm:border sm:border-cinder-line sm:shadow-[0_24px_64px_rgba(13,21,18,0.16),0_2px_6px_rgba(13,21,18,0.06)]"
        >
          <header className="flex items-center gap-3 border-b border-cinder-line bg-cinder-surface px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-3">
            <CinderMark className="h-8 w-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[15px] font-semibold tracking-[-0.015em]">
                Cinder
              </h2>
              <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-cinder-ink-3">AI assistant</p>
            </div>
            {!empty ? (
              <button type="button" onClick={reset} aria-label="Start a new conversation" className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-cinder-ink-3 transition-colors hover:bg-cinder-well hover:text-cinder-ink ${FOCUS}`}>
                <RotateCcw className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            ) : null}
            <button type="button" onClick={close} aria-label="Close the assistant" className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-cinder-ink-3 transition-colors hover:bg-cinder-well hover:text-cinder-ink ${FOCUS}`}>
              <X className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
            </button>
          </header>

          <ol ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation" className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-5">
            <li className="flex flex-col items-start">
              <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-md bg-cinder-surface px-4 py-3 text-[14.5px] leading-relaxed text-cinder-ink-2 ring-1 ring-cinder-line">
                <span className="sr-only">Cinder assistant: </span>
                {WELCOME}
              </p>
            </li>

            {empty ? (
              <li aria-label="Suggested questions">
                <ul className="flex flex-wrap gap-2">
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <li key={prompt}>
                      <button
                        type="button"
                        onClick={() => send(prompt, "suggested")}
                        className={`rounded-full bg-cinder-surface px-3.5 py-2 text-left text-[13.5px] font-medium text-cinder-ink ring-1 ring-cinder-line-strong transition-[box-shadow,color] duration-150 hover:text-cinder-accent hover:ring-cinder-accent/50 ${FOCUS}`}
                      >
                        {prompt}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ) : null}

            {state.messages.map((message) =>
              message.role === "user" ? (
                <li key={message.id} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-cinder-ink px-4 py-3 text-[14.5px] leading-relaxed text-cinder-on-night">
                    <span className="sr-only">You: </span>
                    {message.content}
                  </p>
                </li>
              ) : (
                <li key={message.id} className="flex flex-col items-start gap-2">
                  <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-md bg-cinder-surface px-4 py-3 text-[14.5px] leading-relaxed text-cinder-ink-2 ring-1 ring-cinder-line">
                    <span className="sr-only">Cinder assistant: </span>
                    {message.content}
                  </p>
                  {message.nextStep ? <NextStepButton step={message.nextStep} /> : null}
                </li>
              ),
            )}

            {loading ? (
              <li className="flex items-start" aria-label="Cinder assistant is typing">
                <span className="inline-flex items-center gap-1.5 rounded-2xl rounded-tl-md bg-cinder-surface px-4 py-3.5 ring-1 ring-cinder-line">
                  {[0, 150, 300].map((delay) => (
                    <span key={delay} aria-hidden className="h-1.5 w-1.5 rounded-full bg-cinder-ink-3 motion-safe:animate-pulse" style={{ animationDelay: `${delay}ms` }} />
                  ))}
                </span>
              </li>
            ) : null}

            {state.status === "error" ? (
              <li role="alert" className="rounded-2xl bg-cinder-accent-soft px-4 py-3 text-[14px] leading-relaxed text-cinder-ink-2">
                <p>{FALLBACK_ERROR}</p>
                {lastUserMessage(state) ? (
                  <button type="button" onClick={retry} className={`mt-2 inline-flex items-center gap-1.5 rounded-full text-[13.5px] font-medium text-cinder-accent-strong hover:text-cinder-ink ${FOCUS}`}>
                    <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                    Try again
                  </button>
                ) : null}
              </li>
            ) : null}
          </ol>

          <form onSubmit={onSubmit} className="border-t border-cinder-line bg-cinder-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <div className="flex items-end gap-2 rounded-2xl bg-cinder-canvas px-3 py-2 ring-1 ring-cinder-line-strong transition-shadow focus-within:ring-2 focus-within:ring-cinder-accent">
              <label htmlFor={`${titleId}-input`} className="sr-only">
                Message Cinder
              </label>
              <textarea
                id={`${titleId}-input`}
                ref={inputRef}
                rows={1}
                value={draft}
                maxLength={MAX_INPUT_CHARS}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask about Cinder or Trackpr…"
                // The field's pill shows focus (2px ember ring via focus-within); the global textarea outline would draw a second box inside it.
                style={{ outline: "none" }}
                className="max-h-32 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[16px] leading-snug text-cinder-ink placeholder:text-cinder-ink-3 focus:outline-none sm:text-[14.5px] [field-sizing:content]"
              />
              <button
                type="submit"
                disabled={loading || !draft.trim()}
                aria-label="Send message"
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cinder-ink text-cinder-on-night transition-[background-color,opacity] duration-150 hover:bg-[#1c2824] disabled:cursor-not-allowed disabled:opacity-35 ${FOCUS}`}
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2} aria-hidden />
              </button>
            </div>
            <p className="mt-2 px-1 text-[11.5px] leading-snug text-cinder-ink-3">An AI assistant that answers from this site. It can make mistakes — for anything specific, talk to the team.</p>
          </form>
        </div>
      ) : null}
    </>
  );
}

function NextStepButton({ step }: { step: ChatNextStep }) {
  const className = `group inline-flex items-center gap-1.5 rounded-full bg-cinder-surface px-3.5 py-2 text-[13.5px] font-medium text-cinder-ink ring-1 ring-cinder-accent/60 transition-[background-color,color] duration-150 hover:bg-cinder-accent-soft ${FOCUS}`;
  const onClick = () => {
    if (MEETING_KEYS.has(step.key)) trackChatEvent("meeting_cta_clicked", { key: step.key });
  };
  const inner = (
    <>
      {step.label}
      <ArrowRight className="h-3.5 w-3.5 text-cinder-accent transition-transform duration-150 motion-safe:group-hover:translate-x-0.5" strokeWidth={1.75} aria-hidden />
    </>
  );
  return step.href.startsWith("mailto:") ? (
    <a href={step.href} onClick={onClick} className={className}>
      {inner}
    </a>
  ) : (
    <Link href={step.href} onClick={onClick} className={className}>
      {inner}
    </Link>
  );
}
