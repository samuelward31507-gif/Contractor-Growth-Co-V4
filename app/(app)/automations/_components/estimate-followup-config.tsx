"use client";

import { useState, useTransition } from "react";
import { Settings } from "lucide-react";
import { updateEstimateFollowupConfig } from "../actions";
import { FOLLOWUP_HOURS_MIN, FOLLOWUP_HOURS_MAX } from "@/lib/automation/settings";
import { SectionCard } from "@/lib/ui/section-card";
import { primaryButtonAutoClass } from "@/lib/ui/form";

const numberFieldClass =
  "w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 shadow-sm transition-colors focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Automation Configuration V1 - only ever rendered for org admins, same gate
 * as AppointmentReminderConfigForm (see that component's comment for the
 * shared rationale). `initialFollowup1Hours`/`initialFollowup2Hours` are the
 * real, server-fetched, default-applied values.
 *
 * This only changes how future candidate evaluations compute follow-up
 * timing - it never touches a follow-up that has already been sent or an
 * execution already in flight.
 */
export function EstimateFollowupConfigForm({
  initialFollowup1Hours,
  initialFollowup2Hours,
}: {
  initialFollowup1Hours: number;
  initialFollowup2Hours: number;
}) {
  const [saved, setSaved] = useState({ f1: initialFollowup1Hours, f2: initialFollowup2Hours });
  const [input1, setInput1] = useState(String(initialFollowup1Hours));
  const [input2, setInput2] = useState(String(initialFollowup2Hours));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isDirty = input1 !== String(saved.f1) || input2 !== String(saved.f2);

  function handleSave() {
    setError(null);
    setSuccess(false);

    const f1 = Number(input1);
    const f2 = Number(input2);
    if (!Number.isFinite(f1) || !Number.isInteger(f1) || !Number.isFinite(f2) || !Number.isInteger(f2)) {
      setError("Follow-up timing must be whole numbers.");
      return;
    }
    if (f1 < FOLLOWUP_HOURS_MIN || f1 > FOLLOWUP_HOURS_MAX || f2 < FOLLOWUP_HOURS_MIN || f2 > FOLLOWUP_HOURS_MAX) {
      setError(`Follow-up timing must be between ${FOLLOWUP_HOURS_MIN} and ${FOLLOWUP_HOURS_MAX} hours.`);
      return;
    }
    if (f2 <= f1) {
      setError("Second follow-up must be later than the first follow-up.");
      return;
    }

    startTransition(async () => {
      const result = await updateEstimateFollowupConfig(f1, f2);
      if (result.error) {
        setError(result.error);
        return;
      }
      const newF1 = (result.config?.followup_1_hours as number | undefined) ?? f1;
      const newF2 = (result.config?.followup_2_hours as number | undefined) ?? f2;
      setSaved({ f1: newF1, f2: newF2 });
      setInput1(String(newF1));
      setInput2(String(newF2));
      setSuccess(true);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    });
  }

  return (
    <SectionCard title="Follow-up timing" icon={Settings}>
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
              aria-label="First follow-up, in hours"
              className={numberFieldClass}
            />
            <span className="text-sm text-slate-700">hours</span>
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
              aria-label="Second follow-up, in hours"
              className={numberFieldClass}
            />
            <span className="text-sm text-slate-700">hours</span>
          </div>
        </div>
        <div>
          <button type="button" onClick={handleSave} disabled={isPending || !isDirty} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-400">Changes apply to future follow-ups only - anything already sent or in progress is unaffected.</p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </SectionCard>
  );
}
