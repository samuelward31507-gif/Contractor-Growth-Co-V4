"use client";

import { useState, useTransition } from "react";
import { updateInboundCustomerReplyConfig } from "../actions";
import { RECENT_MESSAGE_WINDOW_MIN, RECENT_MESSAGE_WINDOW_MAX, DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG } from "@/lib/automation/settings";

const DEFAULT_WINDOW = DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG.recent_message_window;

/**
 * Automation Configuration V2.1 - only ever rendered for org admins (the
 * page checks membership.role before rendering this at all, same gate as
 * EnableToggle/AppointmentReminderConfigForm/EstimateFollowupConfigForm).
 * `initialRecentMessageWindow` is the real, server-fetched, default-applied
 * value - never a fake, frontend-only initial state.
 *
 * This only changes how many recent conversation messages are included in
 * the AI's context when drafting a reply - it has no effect on the outbound
 * gate, content safety, opt-out handling, duplicate-send protection, or any
 * message already sent.
 */
export function InboundCustomerReplyConfigForm({ initialRecentMessageWindow }: { initialRecentMessageWindow: number }) {
  const [savedValue, setSavedValue] = useState(initialRecentMessageWindow);
  const [inputValue, setInputValue] = useState(String(initialRecentMessageWindow));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isDirty = inputValue !== String(savedValue);

  function commit(parsed: number) {
    setError(null);
    setSuccess(false);

    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setError("Recent message context must be a whole number.");
      return;
    }
    if (parsed < RECENT_MESSAGE_WINDOW_MIN || parsed > RECENT_MESSAGE_WINDOW_MAX) {
      setError(`Recent message context must be between ${RECENT_MESSAGE_WINDOW_MIN} and ${RECENT_MESSAGE_WINDOW_MAX} messages.`);
      return;
    }

    startTransition(async () => {
      const result = await updateInboundCustomerReplyConfig(parsed);
      if (result.error) {
        setError(result.error);
        return;
      }
      const newValue = (result.config?.recent_message_window as number | undefined) ?? parsed;
      setSavedValue(newValue);
      setInputValue(String(newValue));
      setSuccess(true);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    });
  }

  function handleSave() {
    commit(Number(inputValue));
  }

  function handleReset() {
    setInputValue(String(DEFAULT_WINDOW));
    commit(DEFAULT_WINDOW);
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recent message context</p>
      <p className="mt-1 text-sm text-slate-500">Choose how many recent conversation messages the AI can use when responding to a customer.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setSuccess(false);
          }}
          disabled={isPending}
          className="w-20 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="text-sm text-slate-700">messages</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !isDirty}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={isPending || savedValue === DEFAULT_WINDOW}
          className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-500"
        >
          Reset to default
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Changes apply to future replies only - anything already sent or in progress is unaffected.</p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
