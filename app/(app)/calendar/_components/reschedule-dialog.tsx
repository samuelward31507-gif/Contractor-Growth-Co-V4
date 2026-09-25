"use client";

import { useState, useTransition } from "react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Appointment } from "@/lib/appointments/queries";
import { rescheduleAppointmentTime } from "../../appointments/actions";

function toDateInputValue(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toTimeInputValue(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * Pass 2 (Native Calendar System): a compact time-only reschedule dialog -
 * distinct from the full AppointmentDialog edit form, since a reschedule
 * only ever touches date/start/end (contact/lead/title/notes are
 * unrelated). Submits the raw wall-clock date/startTime/endTime strings the
 * inputs collected, exactly like AppointmentDialog's own form fields -
 * rescheduleAppointmentTime performs the actual wall-clock -> UTC
 * conversion server-side via zonedWallTimeToUtc, in the organization's own
 * configured timezone, so this dialog never re-implements that conversion
 * itself and never trusts a client-computed instant.
 */
export function RescheduleDialog({
  appointment,
  timeZone,
  onClose,
  onRescheduled,
}: {
  appointment: Appointment;
  timeZone?: string;
  onClose: () => void;
  onRescheduled: () => void;
}) {
  const [date, setDate] = useState(toDateInputValue(appointment.start_at, timeZone));
  const [startTime, setStartTime] = useState(toTimeInputValue(appointment.start_at, timeZone));
  const [endTime, setEndTime] = useState(toTimeInputValue(appointment.end_at, timeZone));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!date || !startTime || !endTime) {
      setError("Enter a date, start time, and end time.");
      return;
    }

    startTransition(async () => {
      const result = await rescheduleAppointmentTime(appointment.id, date, startTime, endTime);
      if (result.error) {
        setError(result.error);
        return;
      }
      onRescheduled();
    });
  }

  return (
    <Dialog onClose={onClose} labelledBy="reschedule-dialog-title">
      <DialogTitle id="reschedule-dialog-title">Reschedule Appointment</DialogTitle>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error ? <p className={errorBannerClass}>{error}</p> : null}

        <div className="space-y-1.5">
          <label htmlFor="reschedule-date" className={labelClass}>
            Date
          </label>
          <input id="reschedule-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="reschedule-start" className={labelClass}>
              Start time
            </label>
            <input id="reschedule-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="reschedule-end" className={labelClass}>
              End time
            </label>
            <input id="reschedule-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={inputClass} />
          </div>
        </div>

        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Rescheduling…" : "Reschedule"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
