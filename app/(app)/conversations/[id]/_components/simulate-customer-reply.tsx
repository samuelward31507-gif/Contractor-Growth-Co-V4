"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass, inputClass, secondaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { simulateCustomerReply, type SimulateCustomerReplyState } from "../../actions";

const initialState: SimulateCustomerReplyState = {};

/**
 * TEST-mode-only control, rendered by the conversation page only on a
 * non-production deployment, for an org owner/admin, while the
 * organization is in TEST mode (simulateCustomerReply re-checks all three
 * on every submit). Records the text as if the customer had replied by SMS
 * and runs the normal inbound-reply automation; nothing is ever sent.
 *
 * simulationId is fresh per reply and stable across a double-submit, so a
 * retried submission maps to the same message/event instead of a second one.
 */
export function SimulateCustomerReply({ conversationId, initialSimulationId }: { conversationId: string; initialSimulationId: string }) {
  const [state, formAction, isPending] = useActionState(simulateCustomerReply, initialState);
  // The first id comes from the server render, so SSR and hydration agree.
  const [simulationId, setSimulationId] = useState(initialSimulationId);
  const [handledState, setHandledState] = useState(state);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldId = useId();

  // A new action result: after a success, the next reply gets a fresh id
  // (adjusting state during render rather than in an effect).
  if (state !== handledState) {
    setHandledState(state);
    if (state.success) setSimulationId(crypto.randomUUID());
  }

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state]);

  return (
    <details className="group shrink-0 border-t border-line bg-canvas px-4 py-3 sm:px-6">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-ink-3">
        <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Simulate customer reply
        <Badge tone="warning">TEST mode</Badge>
      </summary>
      <form ref={formRef} action={formAction} className="mt-3 space-y-2">
        {state.error ? <p className={errorBannerClass} role="alert">{state.error}</p> : null}
        {state.success ? (
          <p className={successBannerClass} role="status">
            {state.duplicate ? "This reply was already recorded." : "Reply recorded. The customer reply automation is running."}
          </p>
        ) : null}
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="simulationId" value={simulationId} />
        <label htmlFor={fieldId} className="sr-only">
          Customer reply
        </label>
        <textarea
          id={fieldId}
          name="body"
          rows={2}
          required
          maxLength={1600}
          placeholder="What the customer texts back…"
          className={`${inputClass} resize-none`}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-3">
            Recorded as an inbound customer SMS and processed by your automations. Nothing is sent while
            the organization is in TEST mode.
          </p>
          <button type="submit" disabled={isPending} className={`shrink-0 ${secondaryButtonAutoClass}`}>
            {isPending ? "Recording…" : "Simulate Reply"}
          </button>
        </div>
      </form>
    </details>
  );
}
