"use client";

import { useActionState } from "react";
import { errorBannerClass } from "@/lib/ui/form";
import type { Appointment } from "@/lib/appointments/queries";
import { deleteAppointment, type DeleteAppointmentState } from "../../actions";

const initialState: DeleteAppointmentState = {};

export function DeleteAppointmentDialog({
  appointment,
  onClose,
}: {
  appointment: Appointment;
  onClose: () => void;
}) {
  const [state, formAction, isPending] = useActionState(deleteAppointment, initialState);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Delete this appointment?</h2>
        <p className="mt-2 text-sm text-slate-500">
          This will permanently remove this appointment. The associated contact and lead will not
          be affected.
        </p>

        {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

        <form action={formAction} className="mt-5 flex items-center justify-end gap-3">
          <input type="hidden" name="id" value={appointment.id} />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
          >
            {isPending ? "Deleting…" : "Delete Appointment"}
          </button>
        </form>
      </div>
    </div>
  );
}
