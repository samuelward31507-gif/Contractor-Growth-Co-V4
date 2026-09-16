"use client";

import { useActionState } from "react";
import type { Conversation } from "@/lib/conversations/queries";
import {
  setConversationAiEnabled,
  setConversationStatus,
  type ConversationActionState,
} from "../../actions";

const initialState: ConversationActionState = {};

const buttonClass =
  "inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";

export function ConversationActions({ conversation }: { conversation: Conversation }) {
  const [statusState, statusAction, statusPending] = useActionState(setConversationStatus, initialState);
  const [aiState, aiAction, aiPending] = useActionState(setConversationAiEnabled, initialState);

  const nextStatus = conversation.status === "open" ? "closed" : "open";
  const statusButtonLabel = conversation.status === "open" ? "Close Conversation" : "Reopen Conversation";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <form action={aiAction}>
          <input type="hidden" name="id" value={conversation.id} />
          <input type="hidden" name="aiEnabled" value={(!conversation.ai_enabled).toString()} />
          <button type="submit" disabled={aiPending} className={buttonClass}>
            {aiPending ? "Updating…" : conversation.ai_enabled ? "Disable AI" : "Enable AI"}
          </button>
        </form>
        <form action={statusAction}>
          <input type="hidden" name="id" value={conversation.id} />
          <input type="hidden" name="status" value={nextStatus} />
          <button type="submit" disabled={statusPending} className={buttonClass}>
            {statusPending ? "Updating…" : statusButtonLabel}
          </button>
        </form>
      </div>
      {statusState.error ? <p className="text-xs text-red-600">{statusState.error}</p> : null}
      {aiState.error ? <p className="text-xs text-red-600">{aiState.error}</p> : null}
    </div>
  );
}
