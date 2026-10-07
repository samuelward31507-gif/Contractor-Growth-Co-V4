"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { MessageSquare } from "lucide-react";
import { errorBannerClass, inputClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { sendConversationMessage, type MessageFormState } from "../../actions";

const initialState: MessageFormState = {};

/**
 * Final Batch 1: the contractor's reply box. sendConversationMessage
 * (app/(app)/conversations/actions.ts) sends it to the customer as a real
 * text through Trackpr's one outbound path (opt-out, live mode, payment and
 * the provider result all apply), from the business's number, and it shows
 * in this thread like any other message.
 */
export function MessageComposer({ conversationId }: { conversationId: string }) {
  const [state, formAction, isPending] = useActionState(sendConversationMessage, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldId = useId();

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  return (
    <div className="shrink-0 border-t border-line bg-canvas px-4 py-4 sm:px-6">
      {state.error ? <p className={`mb-2 ${errorBannerClass}`} role="alert">{state.error}</p> : null}
      <form ref={formRef} action={formAction} className="space-y-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <label htmlFor={fieldId} className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
          <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Text the customer
        </label>
        <textarea
          id={fieldId}
          name="body"
          rows={2}
          required
          maxLength={1600}
          placeholder="Write a text message…"
          className={`${inputClass} resize-none`}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-3">Sent to the customer as a text message from your business number.</p>
          <button type="submit" disabled={isPending} className={`shrink-0 ${primaryButtonAutoClass}`}>
            {isPending ? "Sending…" : "Send text"}
          </button>
        </div>
      </form>
    </div>
  );
}
