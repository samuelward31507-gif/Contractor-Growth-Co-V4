"use client";

import { useState, useTransition } from "react";
import { updateAppointmentReminderConfig } from "../actions";
import { REMINDER_LEAD_TIME_MIN_HOURS, REMINDER_LEAD_TIME_MAX_HOURS } from "@/lib/automation/settings";

/**
 * Automation Configuration V1 - only ever rendered for org admins (the page
 * checks membership.role before rendering this at all, same gate as
 * EnableToggle). `initialLeadTimeHours` is the real, server-fetched,
 * default-applied value - never a fake, frontend-only initial state. A
 * successful save updates local state directly from the server action's
 * returned config (rather than waiting on revalidatePath + a full refetch),
 * so the input immediately reflects what was actually persisted.
 *
 * This only changes how future candidate evaluations compute their
 * eligibility window - it never touches a reminder that has already been
 * sent or an execution already in flight.
 */
export function AppointmentReminderConfigForm({ initialLeadTimeHours }: { initialLeadTimeHours: number }) {
  const [savedValue, setSavedValue] = useState(initialLeadTimeHours);
  const [inputValue, setInputValue] = useState(String(initialLeadTimeHours));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isDirty = inputValue !== String(savedValue);

  function handleSave() {
    setError(null);
    setSuccess(false);

    const parsed = Number(inputValue);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setError("Reminder lead time must be a whole number.");
      return;
    }
    if (parsed < REMINDER_LEAD_TIME_MIN_HOURS || parsed > REMINDER_LEAD_TIME_MAX_HOURS) {
      setError(`Reminder lead time must be between ${REMINDER_LEAD_TIME_MIN_HOURS} and ${REMINDER_LEAD_TIME_MAX_HOURS} hours.`);
      return;
    }

    startTransition(async () => {
      const result = await updateAppointmentReminderConfig(parsed);
      if (result.error) {
        setError(result.error);
        return;
      }
      const newValue = (result.config?.reminder_lead_time_hours as number | undefined) ?? parsed;
      setSavedValue(newValue);
      setInputValue(String(newValue));
      setSuccess(true);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Reminder timing</p>
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
        <span className="text-sm text-slate-700">hours before appointment</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !isDirty}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Changes apply to future reminders only - anything already sent or in progress is unaffected.</p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
