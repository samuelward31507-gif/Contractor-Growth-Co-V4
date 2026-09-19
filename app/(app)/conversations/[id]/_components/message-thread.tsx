import { AlertTriangle, Check, CheckCheck, Clock } from "lucide-react";
import {
  SENDER_AVATAR_CLASS,
  SENDER_INITIALS,
  SENDER_LABELS,
  formatMessageTimestamp,
  getMessageDayLabel,
} from "@/lib/conversations/format";
import type { Message } from "@/lib/conversations/queries";
import { MESSAGE_STATUS_LABEL } from "../../_components/status-tone";

// Outbound bubble color per sender - reuses the same identity colors as
// SENDER_AVATAR_CLASS (lib/conversations/format.ts) so "AI" and "You" read
// consistently whether they're an avatar or a bubble, but with text colors
// chosen so every combination clears AA contrast (slate-400's own avatar
// color fails white-on-slate-400, so "System" gets a light bubble instead).
const OUTBOUND_BUBBLE_CLASS: Record<"ai" | "user" | "system", string> = {
  ai: "bg-blue-600 text-white",
  user: "bg-slate-900 text-white",
  system: "bg-slate-200 text-slate-700",
};

function DeliveryStatus({ message }: { message: Message }) {
  const label = MESSAGE_STATUS_LABEL[message.status];

  if (message.status === "failed" || message.status === "undelivered") {
    return (
      <span className="inline-flex items-center gap-1 text-red-600" title={message.status_reason ?? undefined}>
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </span>
    );
  }

  if (message.status === "delivered") {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400">
        <CheckCheck className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </span>
    );
  }

  if (message.status === "queued") {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400">
        <Clock className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </span>
    );
  }

  if (message.status === "logged") {
    return <span className="italic text-slate-400">{label}</span>;
  }

  return (
    <span className="inline-flex items-center gap-1 text-slate-400">
      <Check className="h-3 w-3 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

function MessageRow({ message }: { message: Message }) {
  const time = formatMessageTimestamp(message.created_at);

  if (message.direction === "inbound") {
    return (
      <div className="flex justify-start gap-2" aria-label={`${SENDER_LABELS[message.sender_type]} at ${time}`}>
        <span
          className={`mt-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${SENDER_AVATAR_CLASS[message.sender_type]}`}
          aria-hidden
        >
          {SENDER_INITIALS[message.sender_type]}
        </span>
        <div className="max-w-[85%] sm:max-w-[75%]">
          <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm text-slate-900">
            <p className="whitespace-pre-wrap break-words">{message.body}</p>
          </div>
          <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-slate-400">
            <span>{SENDER_LABELS[message.sender_type]}</span>
            <span aria-hidden>·</span>
            <span>{time}</span>
          </div>
        </div>
      </div>
    );
  }

  const bubbleSender = message.sender_type === "customer" ? "user" : message.sender_type;

  return (
    <div className="flex justify-end" aria-label={`${SENDER_LABELS[message.sender_type]} at ${time}`}>
      <div className="max-w-[85%] sm:max-w-[75%]">
        <div
          className={`rounded-2xl rounded-br-sm px-3.5 py-2 text-sm ${OUTBOUND_BUBBLE_CLASS[bubbleSender]}`}
        >
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </div>
        <div className="mt-1 flex items-center justify-end gap-1.5 px-1 text-[11px] text-slate-400">
          <span>{SENDER_LABELS[message.sender_type]}</span>
          <span aria-hidden>·</span>
          <span>{time}</span>
          <span aria-hidden>·</span>
          <DeliveryStatus message={message} />
        </div>
      </div>
    </div>
  );
}

export function MessageThread({ messages }: { messages: Message[] }) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16 text-center">
        <p className="text-sm text-slate-500">No messages in this conversation yet.</p>
      </div>
    );
  }

  // Grouped, then the group order is reversed for rendering (see the
  // flex-col-reverse container below) - the newest day ends up first in DOM
  // order, which flex-col-reverse then places at the bottom of the screen,
  // so the thread opens already scrolled to the latest message with no
  // client-side scroll-into-view script required.
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const label = getMessageDayLabel(message.created_at);
    const existing = groups.get(label) ?? [];
    existing.push(message);
    groups.set(label, existing);
  }
  const reversedGroups = [...groups.entries()].reverse();

  return (
    <div
      role="log"
      aria-label="Message thread"
      className="flex min-h-0 flex-1 flex-col-reverse gap-6 overflow-y-auto px-4 py-5 sm:px-6"
    >
      {reversedGroups.map(([label, items]) => (
        <div key={label} className="space-y-4">
          <div className="flex items-center justify-center">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500">
              {label}
            </span>
          </div>
          {items.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </div>
      ))}
    </div>
  );
}
