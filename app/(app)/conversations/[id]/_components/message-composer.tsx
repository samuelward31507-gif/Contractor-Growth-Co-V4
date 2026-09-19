"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { NotebookPen } from "lucide-react";
import { errorBannerClass, inputClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { createMessage, type MessageFormState } from "../../actions";

const initialState: MessageFormState = {};

/**
 * There is no real send capability here - createMessage (app/(app)/
 * conversations/actions.ts) always stores this as an internal
 * sender_type "user" / status "logged" record and never transmits
 * anything through SMS, email, or any other channel (that only happens
 * through the automation pipeline). The UI is framed to match that reality
 * rather than reading as an outbound-SMS composer: an explicit "Internal
 * note" label with a notebook icon leads the field (not just fine print
 * underneath), and the submit button uses the secondary (not primary/
 * filled) button tier so it doesn't visually compete with, or get mistaken
 * for, a "send to customer" action.
 */
export function MessageComposer({ conversationId }: { conversationId: string }) {
  const [state, formAction, isPending] = useActionState(createMessage, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldId = useId();

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  return (
    <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
      {state.error ? <p className={`mb-2 ${errorBannerClass}`}>{state.error}</p> : null}
      <form ref={formRef} action={formAction} className="space-y-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <label htmlFor={fieldId} className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <NotebookPen className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Internal note
        </label>
        <textarea
          id={fieldId}
          name="body"
          rows={2}
          required
          placeholder="Add a note to this conversation's history…"
          className={`${inputClass} resize-none`}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-400">
            This adds an internal record to the conversation history. It is not sent to the
            customer through SMS, email, or any other channel.
          </p>
          <button type="submit" disabled={isPending} className={`shrink-0 ${secondaryButtonAutoClass}`}>
            {isPending ? "Logging…" : "Log Note"}
          </button>
        </div>
      </form>
    </div>
  );
}
