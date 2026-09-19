"use client";

import { useState, useTransition } from "react";
import { Settings } from "lucide-react";
import { updateLostLeadNurtureConfig } from "../actions";
import { NURTURE_TOUCH_DAYS_MIN, NURTURE_TOUCH_DAYS_MAX, DEFAULT_LOST_LEAD_NURTURE_CONFIG } from "@/lib/automation/settings";
import { SectionCard } from "@/lib/ui/section-card";
import { primaryButtonAutoClass } from "@/lib/ui/form";

const numberFieldClass =
  "w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 shadow-sm transition-colors focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Automation Configuration V3 - only ever rendered for org admins, same
 * gate as AppointmentReminderConfigForm/EstimateFollowupConfigForm (see
 * that component's comment for the shared rationale). `initialTouch1Days`/
 * `initialTouch2Days` are the real, server-fetched, default-applied
 * values.
 *
 * This only changes how future candidate evaluations compute nurture-touch
 * timing - it never touches a touch that has already been sent or an
 * execution already in flight.
 */
export function LostLeadNurtureConfigForm({
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
    if (t1 < NURTURE_TOUCH_DAYS_MIN || t1 > NURTURE_TOUCH_DAYS_MAX || t2 < NURTURE_TOUCH_DAYS_MIN || t2 > NURTURE_TOUCH_DAYS_MAX) {
      setError(`Follow-up timing must be between ${NURTURE_TOUCH_DAYS_MIN} and ${NURTURE_TOUCH_DAYS_MAX} days.`);
      return;
    }
    if (t2 <= t1) {
      setError("Second follow-up must be later than the first follow-up.");
      return;
    }

    startTransition(async () => {
      const result = await updateLostLeadNurtureConfig(t1, t2);
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
    <SectionCard title="Nurture touch timing" icon={Settings}>
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">First follow-up</p>
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
              aria-label="First follow-up, in days"
              className={numberFieldClass}
            />
            <span className="text-sm text-slate-700">days</span>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Second follow-up</p>
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
              aria-label="Second follow-up, in days"
              className={numberFieldClass}
            />
            <span className="text-sm text-slate-700">days</span>
          </div>
        </div>
        <div>
          <button type="button" onClick={handleSave} disabled={isPending || !isDirty} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Defaults: {DEFAULT_LOST_LEAD_NURTURE_CONFIG.touch_1_days} and {DEFAULT_LOST_LEAD_NURTURE_CONFIG.touch_2_days} days. Changes apply to future
        touches only - anything already sent or in progress is unaffected.
      </p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </SectionCard>
  );
}
