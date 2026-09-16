"use client";

import { useActionState, useEffect, useRef } from "react";
import { errorBannerClass, inputClass } from "@/lib/ui/form";
import { createMessage, type MessageFormState } from "../../actions";

const initialState: MessageFormState = {};

export function MessageComposer({ conversationId }: { conversationId: string }) {
  const [state, formAction, isPending] = useActionState(createMessage, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  return (
    <div className="border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
      {state.error ? <p className={`mb-2 ${errorBannerClass}`}>{state.error}</p> : null}
      <form ref={formRef} action={formAction} className="space-y-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <textarea
          name="body"
          rows={2}
          required
          placeholder="Log a message in this conversation…"
          className={inputClass}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-400">
            This adds an internal record to the conversation history. It is not sent to the
            customer through SMS, email, or any other channel.
          </p>
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {isPending ? "Logging…" : "Log Message"}
          </button>
        </div>
      </form>
    </div>
  );
}
