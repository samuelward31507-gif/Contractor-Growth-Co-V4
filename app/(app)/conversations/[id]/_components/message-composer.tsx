"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { errorBannerClass, inputClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { createMessage, type MessageFormState } from "../../actions";

const initialState: MessageFormState = {};

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
        <label htmlFor={fieldId} className="sr-only">
          Log a message in this conversation
        </label>
        <textarea
          id={fieldId}
          name="body"
          rows={2}
          required
          placeholder="Log a message in this conversation…"
          className={`${inputClass} resize-none`}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-400">
            This adds an internal record to the conversation history. It is not sent to the
            customer through SMS, email, or any other channel.
          </p>
          <button type="submit" disabled={isPending} className={`shrink-0 ${primaryButtonAutoClass}`}>
            {isPending ? "Logging…" : "Log Message"}
          </button>
        </div>
      </form>
    </div>
  );
}
