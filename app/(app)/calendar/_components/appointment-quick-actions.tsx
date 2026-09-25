"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, CheckCheck, Ban, UserX, Clock } from "lucide-react";
import { errorBannerClass, destructiveButtonAutoClass, secondaryButtonAutoClass, ghostButtonClass } from "@/lib/ui/form";
import type { Appointment, AppointmentStatus } from "@/lib/appointments/queries";
import { updateAppointmentStatus } from "../../appointments/actions";
import { RescheduleDialog } from "./reschedule-dialog";

/**
 * Pass 2 (Native Calendar System): the one-click Confirm/Reschedule/Cancel/
 * Complete/No-show actions (Phase 6). Calls the calendar-specific
 * server actions added to app/(app)/appointments/actions.ts
 * (updateAppointmentStatus/rescheduleAppointmentTime) directly as async
 * functions - not through a <form action> - since these are single-value
 * button clicks, not form submissions; React lets a Server Action be
 * invoked this way from a Client Component. Cancel is destructive, so it
 * requires an explicit confirm step (Phase 6's own "use confirmation where
 * destructive or consequential" instruction) before it ever calls the
 * action.
 */
export function AppointmentQuickActions({ appointment, timeZone, onChanged }: { appointment: Appointment; timeZone?: string; onChanged: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  function runStatusChange(status: AppointmentStatus) {
    setError(null);
    startTransition(async () => {
      const result = await updateAppointmentStatus(appointment.id, status);
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirmingCancel(false);
      onChanged();
    });
  }

  const isActive = appointment.status === "scheduled" || appointment.status === "confirmed";

  if (!isActive) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? <p className={errorBannerClass}>{error}</p> : null}

      {confirmingCancel ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="flex-1 text-xs font-medium text-red-700">Cancel this appointment?</p>
          <button type="button" onClick={() => setConfirmingCancel(false)} className={ghostButtonClass} disabled={isPending}>
            No
          </button>
          <button type="button" onClick={() => runStatusChange("cancelled")} disabled={isPending} className={destructiveButtonAutoClass}>
            {isPending ? "Cancelling…" : "Yes, cancel"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {appointment.status === "scheduled" ? (
            <button type="button" onClick={() => runStatusChange("confirmed")} disabled={isPending} className={secondaryButtonAutoClass}>
              <CheckCircle2 aria-hidden className="h-4 w-4" />
              Confirm
            </button>
          ) : null}
          <button type="button" onClick={() => setRescheduling(true)} disabled={isPending} className={secondaryButtonAutoClass}>
            <Clock aria-hidden className="h-4 w-4" />
            Reschedule
          </button>
          <button type="button" onClick={() => runStatusChange("completed")} disabled={isPending} className={secondaryButtonAutoClass}>
            <CheckCheck aria-hidden className="h-4 w-4" />
            Complete
          </button>
          <button type="button" onClick={() => runStatusChange("no_show")} disabled={isPending} className={secondaryButtonAutoClass}>
            <UserX aria-hidden className="h-4 w-4" />
            No-show
          </button>
          <button type="button" onClick={() => setConfirmingCancel(true)} disabled={isPending} className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50">
            <Ban aria-hidden className="h-4 w-4" />
            Cancel
          </button>
        </div>
      )}

      {rescheduling ? (
        <RescheduleDialog
          appointment={appointment}
          timeZone={timeZone}
          onClose={() => setRescheduling(false)}
          onRescheduled={() => {
            setRescheduling(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
