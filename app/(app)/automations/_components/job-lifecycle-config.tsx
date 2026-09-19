"use client";

import { useState, useTransition } from "react";
import { updateJobLifecycleConfig } from "../actions";
import { BusinessHoursToggleField } from "./business-hours-toggle-field";

/**
 * Automation Configuration V5 - only ever rendered for org admins (the
 * page checks membership.role before rendering this at all, same gate as
 * EnableToggle/InstantLeadFollowupConfigForm). `initialRespectBusinessHours`
 * is the real, server-fetched, default-applied value.
 *
 * This only changes whether the outbound gate additionally requires the
 * organization's business hours to be open before allowing this
 * automation's send - no effect on the outbound gate's other checks,
 * content safety, opt-out handling, duplicate-send protection, or any
 * message already sent.
 */
export function JobLifecycleConfigForm({
  initialRespectBusinessHours,
  hasBusinessHoursConfigured,
}: {
  initialRespectBusinessHours: boolean;
  hasBusinessHoursConfigured: boolean;
}) {
  const [savedValue, setSavedValue] = useState(initialRespectBusinessHours);
  const [respectHours, setRespectHours] = useState(initialRespectBusinessHours);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isDirty = respectHours !== savedValue;

  function commit(value: boolean) {
    setError(null);
    setSuccess(false);

    startTransition(async () => {
      const result = await updateJobLifecycleConfig(value);
      if (result.error) {
        setError(result.error);
        return;
      }
      const newValue = (result.config?.respect_business_hours as boolean | undefined) ?? value;
      setSavedValue(newValue);
      setRespectHours(newValue);
      setSuccess(true);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    });
  }

  function handleSave() {
    commit(respectHours);
  }

  function handleReset() {
    setRespectHours(false);
    commit(false);
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Sending window</p>
      <p className="mt-1 text-sm text-slate-500">Choose whether this automation only sends automatically during business hours.</p>

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
          disabled={isPending || savedValue === false}
          className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-500"
        >
          Reset to default
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Changes apply to future sends only - anything already sent or in progress is unaffected.</p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
