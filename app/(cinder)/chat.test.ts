/**
 * The Cinder website assistant's client side: conversation state
 * transitions (pure reducer) and the component's structure - opening,
 * closing, sending, loading, error fallback, suggested prompts, next-step
 * buttons, mobile presentation and accessibility. This repository has no
 * DOM test environment, so the component is verified against its source,
 * the same convention the site's other tests use.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(cinder)/chat.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  FALLBACK_ERROR,
  INITIAL_STATE,
  MAX_INPUT_CHARS,
  MAX_STORED_MESSAGES,
  SUGGESTED_PROMPTS,
  WELCOME,
  chatReducer,
  isSiteHref,
  lastUserMessage,
  sanitizeStored,
  toRequestMessages,
  type ChatMessage,
} from "./_components/chat-state";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/cinder-chat/conversation";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const CHAT = read("app/(cinder)/_components/chat.tsx");
const user = (content: string, id = content): ChatMessage => ({ id, role: "user", content });
const assistant = (content: string, id = content): ChatMessage => ({ id, role: "assistant", content });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test("state: opens and closes without touching the conversation", () => {
  const opened = chatReducer(INITIAL_STATE, { type: "open" });
  assert.equal(opened.open, true);
  const withMessage = chatReducer(opened, { type: "send", message: user("hi") });
  const closed = chatReducer(withMessage, { type: "close" });
  assert.equal(closed.open, false);
  assert.deepEqual(closed.messages, withMessage.messages);
});

test("state: sending shows loading, a reply returns to idle, and a second send while loading is ignored", () => {
  let state = chatReducer(INITIAL_STATE, { type: "send", message: user("What does Cinder do?") });
  assert.equal(state.status, "loading");
  const ignored = chatReducer(state, { type: "send", message: user("again") });
  assert.equal(ignored, state, "no double submit");
  state = chatReducer(state, { type: "receive", message: assistant("Cinder builds revenue systems.") });
  assert.equal(state.status, "idle");
  assert.deepEqual(state.messages.map((m) => m.role), ["user", "assistant"]);
});

test("state: a failure keeps the visitor's message and can be retried; reset clears everything but stays open", () => {
  let state = chatReducer({ ...INITIAL_STATE, open: true }, { type: "send", message: user("hi") });
  state = chatReducer(state, { type: "fail" });
  assert.equal(state.status, "error");
  assert.equal(lastUserMessage(state)?.content, "hi");
  state = chatReducer(state, { type: "retry" });
  assert.equal(state.status, "loading");
  state = chatReducer(state, { type: "reset" });
  assert.deepEqual(state, { ...INITIAL_STATE, open: true });
});

test("state: the transcript is bounded and the request carries role and text only", () => {
  let state = INITIAL_STATE;
  for (let i = 0; i < 30; i += 1) {
    state = chatReducer(state, { type: "send", message: user(`q${i}`) });
    state = chatReducer(state, { type: "receive", message: { ...assistant(`a${i}`), nextStep: { key: "demo", label: "Demo", href: "/demo" } } });
  }
  assert.equal(state.messages.length, MAX_STORED_MESSAGES);
  assert.deepEqual(Object.keys(toRequestMessages(state.messages)[0]).sort(), ["content", "role"]);
});

test("state: restored storage is untrusted - malformed entries, foreign links and a dangling question are dropped", () => {
  const restored = sanitizeStored([
    user("q1"),
    { ...assistant("a1"), nextStep: { key: "x", label: "Evil", href: "https://evil.example" } },
    { id: 3, role: "user", content: "bad id" },
    { id: "4", role: "system", content: "bad role" },
    user("q2"),
    { ...assistant("a2"), nextStep: { key: "get_started", label: "Tell us about your business", href: "/get-started" } },
    user("unanswered"),
  ]);
  assert.deepEqual(restored.map((m) => m.content), ["q1", "a1", "q2", "a2"]);
  assert.equal(restored[1].nextStep, null);
  assert.equal(restored[3].nextStep?.href, "/get-started");
  assert.deepEqual(sanitizeStored("not an array"), []);
  for (const href of ["/get-started", "mailto:team@example.com"]) assert.equal(isSiteHref(href), true, href);
  for (const href of ["//evil.example", "https://evil.example", "javascript:alert(1)"]) assert.equal(isSiteHref(href), false, href);
});

// ---------------------------------------------------------------------------
// Opening experience
// ---------------------------------------------------------------------------

test("opening: a short welcome and four suggested prompts that start real conversations", () => {
  assert.ok(WELCOME.length < 200, "concise welcome");
  assert.match(WELCOME, /Ask me anything about Cinder or Trackpr/);
  assert.deepEqual([...SUGGESTED_PROMPTS], ["What does Cinder actually do?", "How does Trackpr work?", "Would this work for my business?", "I want to see if this is a fit"]);
  assert.match(CHAT, /onClick=\{\(\) => send\(prompt, "suggested"\)\}/, "a prompt is sent as a message, not a link");
  assert.match(CHAT, /\{empty \? \(\s*<li aria-label="Suggested questions">/);
});

test("opening: the degraded-mode message is the approved fallback", () => {
  assert.equal(FALLBACK_ERROR, "Looks like I'm having trouble connecting right now. You can still use the site to learn about Cinder or get in touch with the team.");
  assert.match(CHAT, /role="alert"[\s\S]*\{FALLBACK_ERROR\}[\s\S]*Try again/);
});

// ---------------------------------------------------------------------------
// Component behaviour
// ---------------------------------------------------------------------------

test("component: Enter sends, Shift+Enter breaks the line, the input limit matches the server's, and sending is disabled while loading", () => {
  assert.match(CHAT, /event\.key === "Enter" && !event\.shiftKey && !event\.nativeEvent\.isComposing/);
  assert.equal(MAX_INPUT_CHARS, MAX_USER_MESSAGE_CHARS);
  assert.match(CHAT, /maxLength=\{MAX_INPUT_CHARS\}/);
  assert.match(CHAT, /disabled=\{loading \|\| !draft\.trim\(\)\}/);
});

test("component: replies come only from the server route, are rendered as text, and a request can never hang", () => {
  assert.match(CHAT, /fetch\("\/api\/cinder\/chat"/);
  assert.doesNotMatch(CHAT, /dangerouslySetInnerHTML|ANTHROPIC|anthropic/);
  assert.match(CHAT, /window\.setTimeout\(\(\) => controller\.abort\(\), REQUEST_TIMEOUT_MS\)/);
  assert.match(CHAT, /dispatch\(\{ type: "fail" \}\)/);
  assert.match(CHAT, /isSiteHref\(step\.href\)/, "a next step from the server is re-checked before it becomes a link");
});

test("component: the conversation survives navigation (mounted once in the Cinder layout) and refresh (session storage, failure-tolerant)", () => {
  const layout = read("app/(cinder)/layout.tsx");
  assert.match(layout, /import \{ CinderChat \} from "\.\/_components\/chat";/);
  assert.equal((layout.match(/<CinderChat \/>/g) ?? []).length, 1);
  assert.match(CHAT, /window\.sessionStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(CHAT, /catch \{\s*return \[\];/);
});

test("component: mobile presentation - full-height panel tracking the visible viewport, safe areas, and no page scroll behind it", () => {
  assert.match(CHAT, /fixed inset-x-0 top-\[var\(--chat-top,0px\)\] z-50 flex h-\[var\(--chat-vh,100dvh\)\]/);
  assert.match(CHAT, /window\.visualViewport/);
  assert.match(CHAT, /sm:w-\[400px\]/, "a floating card from sm up");
  assert.match(CHAT, /env\(safe-area-inset-bottom\)/);
  assert.match(CHAT, /matchMedia\("\(max-width: 639px\)"\)[\s\S]*document\.body\.style\.overflow = "hidden"/);
  assert.match(CHAT, /text-\[16px\][^"]*sm:text-\[14\.5px\]/, "16px input on phones - no iOS zoom on focus");
  assert.match(CHAT, /break-words/, "long words never overflow horizontally");
});

test("accessibility: labelled dialog, live log, labelled controls, Escape to close with focus returned, visible focus, reduced motion", () => {
  assert.match(CHAT, /role="dialog"\s*aria-modal="false"\s*aria-labelledby=\{titleId\}/);
  assert.match(CHAT, /role="log" aria-live="polite"/);
  assert.match(CHAT, /aria-label="Ask Cinder - open the website assistant"/);
  assert.match(CHAT, /aria-label="Close the assistant"/);
  assert.match(CHAT, /aria-label="Send message"/);
  assert.match(CHAT, /aria-label="Start a new conversation"/);
  assert.match(CHAT, /<label htmlFor=\{`\$\{titleId\}-input`\} className="sr-only">/);
  assert.match(CHAT, /event\.key === "Escape"[\s\S]*close\(\)/);
  assert.match(CHAT, /launcherRef\.current\?\.focus\(\)/);
  assert.match(CHAT, /<span className="sr-only">You: <\/span>/);
  assert.match(CHAT, /<span className="sr-only">Cinder assistant: <\/span>/);
  assert.match(CHAT, /aria-label="Cinder assistant is typing"/);
  assert.match(CHAT, /focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent/);
  // The message field shows focus as one 2px ember ring on its pill (never a second box inside it).
  assert.match(CHAT, /focus-within:ring-2 focus-within:ring-cinder-accent/);
  assert.match(CHAT, /style=\{\{ outline: "none" \}\}/);
  // Motion only through classes that are opt-in under prefers-reduced-motion: no-preference.
  assert.match(CHAT, /ui-rise/);
  assert.match(read("app/globals.css"), /@media \(prefers-reduced-motion: no-preference\) \{\s*\.ui-rise/);
  for (const animated of CHAT.match(/animate-[a-z]+/g) ?? []) assert.ok(CHAT.includes(`motion-safe:${animated}`), animated);
  assert.match(CHAT, /AI assistant/, "never presented as a person");
});

test("design: Cinder tokens only - no second visual language", () => {
  const colors = CHAT.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual([...new Set(colors)], ["#1c2824"], "the one literal is the site Button's own hover ink");
  assert.match(CHAT, /rounded-\[24px\]/);
  assert.match(CHAT, /bg-cinder-ink/);
  assert.match(CHAT, /bg-cinder-canvas/);
  assert.match(CHAT, /font-mono text-\[10\.5px\] font-medium uppercase tracking-\[0\.12em\]/, "the site's mono eyebrow notation");
});

test("analytics: an event boundary with no vendor and no message content", () => {
  const analytics = read("app/(cinder)/_components/chat-analytics.ts");
  assert.match(analytics, /new CustomEvent<ChatEventDetail>\(CHAT_EVENT/);
  assert.doesNotMatch(analytics, /fetch\(|sendBeacon|gtag|posthog|segment|plausible/i);
  for (const event of ["opened", "first_message", "suggested_prompt_selected", "meaningful_conversation", "qualification_signal", "meeting_cta_shown", "meeting_cta_clicked", "conversation_ended"]) {
    assert.match(CHAT, new RegExp(`trackChatEvent\\("${event}"`), event);
  }
  // Event properties (everything after the event name) never carry what anyone wrote.
  for (const call of CHAT.match(/trackChatEvent\("[a-z_]+",[^)]*\)/g) ?? []) assert.doesNotMatch(call.slice(call.indexOf(",")), /content|draft|text|reply|message\b/, call);
});
