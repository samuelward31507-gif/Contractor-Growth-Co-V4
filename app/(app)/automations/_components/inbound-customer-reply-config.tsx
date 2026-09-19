"use client";

import { useState, useTransition } from "react";
import { Settings } from "lucide-react";
import { updateInboundCustomerReplyConfig } from "../actions";
import { RECENT_MESSAGE_WINDOW_MIN, RECENT_MESSAGE_WINDOW_MAX, DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG } from "@/lib/automation/settings";
import { BusinessHoursToggleField } from "./business-hours-toggle-field";
import { SectionCard } from "@/lib/ui/section-card";
import { primaryButtonAutoClass } from "@/lib/ui/form";

const DEFAULT_WINDOW = DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG.recent_message_window;
const DEFAULT_RESPECT_HOURS = DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG.respect_business_hours;

/**
 * Automation Configuration V2.1/V2.2 - only ever rendered for org admins
 * (the page checks membership.role before rendering this at all, same gate
 * as EnableToggle/AppointmentReminderConfigForm/EstimateFollowupConfigForm).
 * `initialRecentMessageWindow`/`initialRespectBusinessHours` are the real,
 * server-fetched, default-applied values - never fake, frontend-only
 * initial state. Both fields save together as one config object (the
 * established V1/V2.1 upsert pattern replaces the whole stored config).
 *
 * recent_message_window only changes how many recent conversation messages
 * are included in the AI's context when drafting a reply.
 * respect_business_hours only changes whether the outbound gate
 * additionally requires the organization's business hours to be open
 * before allowing this automation's send. Neither has any effect on the
 * outbound gate's other checks, content safety, opt-out handling,
 * duplicate-send protection, or any message already sent.
 */
export function InboundCustomerReplyConfigForm({
  initialRecentMessageWindow,
  initialRespectBusinessHours,
  hasBusinessHoursConfigured,
}: {
  initialRecentMessageWindow: number;
  initialRespectBusinessHours: boolean;
  hasBusinessHoursConfigured: boolean;
}) {
  const [savedWindow, setSavedWindow] = useState(initialRecentMessageWindow);
  const [savedRespectHours, setSavedRespectHours] = useState(initialRespectBusinessHours);
  const [inputValue, setInputValue] = useState(String(initialRecentMessageWindow));
  const [respectHours, setRespectHours] = useState(initialRespectBusinessHours);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isDirty = inputValue !== String(savedWindow) || respectHours !== savedRespectHours;
  const isAtDefault = savedWindow === DEFAULT_WINDOW && savedRespectHours === DEFAULT_RESPECT_HOURS;

  function commit(parsedWindow: number, respectBusinessHours: boolean) {
    setError(null);
    setSuccess(false);

    if (!Number.isFinite(parsedWindow) || !Number.isInteger(parsedWindow)) {
      setError("Recent message context must be a whole number.");
      return;
    }
    if (parsedWindow < RECENT_MESSAGE_WINDOW_MIN || parsedWindow > RECENT_MESSAGE_WINDOW_MAX) {
      setError(`Recent message context must be between ${RECENT_MESSAGE_WINDOW_MIN} and ${RECENT_MESSAGE_WINDOW_MAX} messages.`);
      return;
    }

    startTransition(async () => {
      const result = await updateInboundCustomerReplyConfig(parsedWindow, respectBusinessHours);
      if (result.error) {
        setError(result.error);
        return;
      }
      const newWindow = (result.config?.recent_message_window as number | undefined) ?? parsedWindow;
      const newRespectHours = (result.config?.respect_business_hours as boolean | undefined) ?? respectBusinessHours;
      setSavedWindow(newWindow);
      setSavedRespectHours(newRespectHours);
      setInputValue(String(newWindow));
      setRespectHours(newRespectHours);
      setSuccess(true);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    });
  }

  function handleSave() {
    commit(Number(inputValue), respectHours);
  }

  function handleReset() {
    setInputValue(String(DEFAULT_WINDOW));
    setRespectHours(DEFAULT_RESPECT_HOURS);
    commit(DEFAULT_WINDOW, DEFAULT_RESPECT_HOURS);
  }

  return (
    <SectionCard title="Recent message context" description="Choose how many recent conversation messages the AI can use when responding to a customer." icon={Settings}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setSuccess(false);
          }}
          disabled={isPending}
          aria-label="Recent message context, in messages"
          className="w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 shadow-sm transition-colors focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="text-sm text-slate-700">messages</span>
      </div>

      <BusinessHoursToggleField
        checked={respectHours}
        onChange={(next) => {
          setRespectHours(next);
          setSuccess(false);
        }}
        disabled={isPending}
        hasBusinessHoursConfigured={hasBusinessHoursConfigured}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={handleSave} disabled={isPending || !isDirty} className={primaryButtonAutoClass}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={isPending || isAtDefault}
          className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-500"
        >
          Reset to default
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Changes apply to future replies only - anything already sent or in progress is unaffected.</p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </SectionCard>
  );
}
