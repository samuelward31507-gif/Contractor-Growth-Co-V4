"use client";

import { useActionState } from "react";
import { Bot, CheckCircle2, RotateCcw } from "lucide-react";
import type { Conversation } from "@/lib/conversations/queries";
import {
  setConversationAiEnabled,
  setConversationStatus,
  type ConversationActionState,
} from "../../actions";

const initialState: ConversationActionState = {};

const buttonClass =
  "inline-flex items-center gap-2 rounded-lg border border-slate-300 px-2.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 sm:px-3.5";

export function ConversationActions({ conversation }: { conversation: Conversation }) {
  const [statusState, statusAction, statusPending] = useActionState(setConversationStatus, initialState);
  const [aiState, aiAction, aiPending] = useActionState(setConversationAiEnabled, initialState);

  const nextStatus = conversation.status === "open" ? "closed" : "open";
  const aiLabel = aiPending ? "Updating…" : conversation.ai_enabled ? "Disable AI" : "Enable AI";
  const statusLabel = statusPending
    ? "Updating…"
    : conversation.status === "open"
      ? "Close conversation"
      : "Reopen conversation";
  const StatusIcon = conversation.status === "open" ? CheckCircle2 : RotateCcw;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <form action={aiAction}>
          <input type="hidden" name="id" value={conversation.id} />
          <input type="hidden" name="aiEnabled" value={(!conversation.ai_enabled).toString()} />
          <button type="submit" disabled={aiPending} aria-label={aiLabel} className={buttonClass}>
            <Bot className="h-4 w-4 shrink-0" aria-hidden />
            <span className="hidden sm:inline">{aiLabel}</span>
          </button>
        </form>
        <form action={statusAction}>
          <input type="hidden" name="id" value={conversation.id} />
          <input type="hidden" name="status" value={nextStatus} />
          <button type="submit" disabled={statusPending} aria-label={statusLabel} className={buttonClass}>
            <StatusIcon className="h-4 w-4 shrink-0" aria-hidden />
            <span className="hidden sm:inline">{statusLabel}</span>
          </button>
        </form>
      </div>
      {statusState.error ? <p className="text-xs text-red-600">{statusState.error}</p> : null}
      {aiState.error ? <p className="text-xs text-red-600">{aiState.error}</p> : null}
    </div>
  );
}
