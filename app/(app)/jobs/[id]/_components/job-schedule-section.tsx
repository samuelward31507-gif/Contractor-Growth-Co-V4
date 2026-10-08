"use client";

import { useActionState, useId, useState } from "react";
import { CalendarClock } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { detailLabelClass, detailValueClass } from "@/lib/ui/typography";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass, ghostButtonClass } from "@/lib/ui/form";
import { scheduleJob, type ScheduleJobFormState } from "../../actions";

/**
 * When the work is scheduled with the customer (jobs.scheduled_for). The
 * date and time are entered and shown in the organization's timezone; the
 * page passes the display string and the input values already resolved in
 * that zone, so the browser's own timezone never enters into it.
 */
export function JobScheduleSection({
  jobId,
  scheduledLabel,
  initialDate,
  initialTime,
  timeZoneLabel,
  canSchedule,
  awaitingApprovedSchedule,
}: {
  jobId: string;
  /** The scheduled date/time, formatted in the organization's timezone; null when not scheduled. */
  scheduledLabel: string | null;
  initialDate: string;
  initialTime: string;
  timeZoneLabel: string;
  /** Active jobs only (scheduled / in progress). */
  canSchedule: boolean;
  /** The customer approved the estimate and the work has not been scheduled yet. */
  awaitingApprovedSchedule: boolean;
}) {
  const [state, formAction, isPending] = useActionState<ScheduleJobFormState, FormData>(scheduleJob, {});
  // Change opens the form against the current result; a later save closes it, an error keeps it open.
  const [editingFrom, setEditingFrom] = useState<ScheduleJobFormState | null>(null);
  const editing = editingFrom !== null && (editingFrom === state || !state.success);
  const id = useId();

  const showForm = canSchedule && (scheduledLabel === null || editing);

  return (
    <SectionCard title="Schedule" icon={CalendarClock}>
      {scheduledLabel !== null && !editing ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className={detailLabelClass}>Scheduled for</p>
            <p className={`${detailValueClass} tabular-nums`}>{scheduledLabel}</p>
          </div>
          {canSchedule ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setEditingFrom(state)} className={secondaryButtonAutoClass}>
                Change
              </button>
              <form action={formAction}>
                <input type="hidden" name="jobId" value={jobId} />
                <input type="hidden" name="intent" value="clear" />
                <button type="submit" disabled={isPending} className={ghostButtonClass}>
                  {isPending ? "Clearing…" : "Clear"}
                </button>
              </form>
            </div>
          ) : null}
        </div>
      ) : null}

      {scheduledLabel === null && !canSchedule ? (
        <div>
          <p className={detailLabelClass}>Scheduled for</p>
          <p className={detailValueClass}>—</p>
        </div>
      ) : null}

      {showForm ? (
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="jobId" value={jobId} />
          {scheduledLabel === null ? (
            <div>
              <p className="text-sm font-medium text-ink">Not scheduled yet</p>
              <p className="mt-1 text-sm text-ink-2">
                {awaitingApprovedSchedule ? "The customer approved this estimate. Set the date for the work." : "Set the date and time for the work."}
              </p>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-date`} className={labelClass}>
                Date
              </label>
              <input id={`${id}-date`} name="date" type="date" required defaultValue={initialDate} className={inputClass} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-time`} className={labelClass}>
                Time
              </label>
              <input id={`${id}-time`} name="time" type="time" required defaultValue={initialTime} className={inputClass} />
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
                {isPending ? "Saving…" : scheduledLabel === null ? "Schedule" : "Save"}
              </button>
              {editing ? (
                <button type="button" onClick={() => setEditingFrom(null)} className={ghostButtonClass}>
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-ink-3">Times are in {timeZoneLabel}.</p>
        </form>
      ) : null}

      {state.error ? (
        <p role="alert" className={`mt-3 ${errorBannerClass}`}>
          {state.error}
        </p>
      ) : null}
    </SectionCard>
  );
}
