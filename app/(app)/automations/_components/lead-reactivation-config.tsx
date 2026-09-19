"use client";

import { useState, useTransition } from "react";
import { updateLeadReactivationConfig } from "../actions";
import { REACTIVATION_TOUCH_DAYS_MIN, REACTIVATION_TOUCH_DAYS_MAX, DEFAULT_LEAD_REACTIVATION_CONFIG } from "@/lib/automation/settings";

/**
 * Automation Configuration V4 - only ever rendered for org admins, same
 * gate as AppointmentReminderConfigForm/EstimateFollowupConfigForm/
 * LostLeadNurtureConfigForm (see that component's comment for the shared
 * rationale). `initialTouch1Days`/`initialTouch2Days` are the real,
 * server-fetched, default-applied values.
 *
 * This only changes how future candidate evaluations compute
 * reactivation-touch timing - it never touches a touch that has already
 * been sent or an execution already in flight.
 */
export function LeadReactivationConfigForm({
  initialTouch1Days,
  initialTouch2Days,
}: {
  initialTouch1Days: number;
  initialTouch2Days: number;
}) {
  const [saved, setSaved] = useState({ t1: initialTouch1Days, t2: initialTouch2Days });
  const [input1, setInput1] = useState(String(initialTouch1Days));
  const [input2, setInput2] = useState(String(initialTouch2Days));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isDirty = input1 !== String(saved.t1) || input2 !== String(saved.t2);

  function handleSave() {
    setError(null);
    setSuccess(false);

    const t1 = Number(input1);
    const t2 = Number(input2);
    if (!Number.isFinite(t1) || !Number.isInteger(t1) || !Number.isFinite(t2) || !Number.isInteger(t2)) {
      setError("Follow-up timing must be whole numbers.");
      return;
    }
    if (t1 < REACTIVATION_TOUCH_DAYS_MIN || t1 > REACTIVATION_TOUCH_DAYS_MAX || t2 < REACTIVATION_TOUCH_DAYS_MIN || t2 > REACTIVATION_TOUCH_DAYS_MAX) {
      setError(`Follow-up timing must be between ${REACTIVATION_TOUCH_DAYS_MIN} and ${REACTIVATION_TOUCH_DAYS_MAX} days.`);
      return;
    }
    if (t2 <= t1) {
      setError("Second reactivation touch must be later than the first.");
      return;
    }

    startTransition(async () => {
      const result = await updateLeadReactivationConfig(t1, t2);
      if (result.error) {
        setError(result.error);
        return;
      }
      const newT1 = (result.config?.touch_1_days as number | undefined) ?? t1;
      const newT2 = (result.config?.touch_2_days as number | undefined) ?? t2;
      setSaved({ t1: newT1, t2: newT2 });
      setInput1(String(newT1));
      setInput2(String(newT2));
      setSuccess(true);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">First reactivation touch</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              value={input1}
              onChange={(e) => {
                setInput1(e.target.value);
                setSuccess(false);
              }}
              disabled={isPending}
              className="w-20 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span className="text-sm text-slate-700">days</span>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Second reactivation touch</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              value={input2}
              onChange={(e) => {
                setInput2(e.target.value);
                setSuccess(false);
              }}
              disabled={isPending}
              className="w-20 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span className="text-sm text-slate-700">days</span>
          </div>
        </div>
        <div>
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending || !isDirty}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Defaults: {DEFAULT_LEAD_REACTIVATION_CONFIG.touch_1_days} and {DEFAULT_LEAD_REACTIVATION_CONFIG.touch_2_days} days. Changes apply to future
        touches only - anything already sent or in progress is unaffected.
      </p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
