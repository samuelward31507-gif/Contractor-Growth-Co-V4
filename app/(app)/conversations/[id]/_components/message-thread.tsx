import {
  DIRECTION_LABELS,
  SENDER_AVATAR_CLASS,
  SENDER_INITIALS,
  SENDER_LABELS,
  formatMessageTimestamp,
  getMessageDayLabel,
} from "@/lib/conversations/format";
import type { Message } from "@/lib/conversations/queries";

function MessageRow({ message }: { message: Message }) {
  return (
    <div className="flex gap-3">
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${SENDER_AVATAR_CLASS[message.sender_type]}`}
      >
        {SENDER_INITIALS[message.sender_type]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-900">{SENDER_LABELS[message.sender_type]}</span>
          <span className="text-xs text-slate-400">{DIRECTION_LABELS[message.direction]}</span>
          <span className="text-xs text-slate-400">·</span>
          <span className="text-xs text-slate-400">{formatMessageTimestamp(message.created_at)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{message.body}</p>
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

  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const label = getMessageDayLabel(message.created_at);
    const existing = groups.get(label) ?? [];
    existing.push(message);
    groups.set(label, existing);
  }

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6">
      {[...groups.entries()].map(([label, items]) => (
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
