"use client";

import { useActionState } from "react";
import { destructiveButtonAutoClass, errorBannerClass, ghostButtonClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
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
    <Dialog onClose={onClose} labelledBy="delete-appointment-title">
      <DialogTitle id="delete-appointment-title">Delete this appointment?</DialogTitle>
      <DialogDescription>
        This will permanently remove this appointment. The associated contact and lead will not be affected.
      </DialogDescription>

      {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

      <form action={formAction}>
        <input type="hidden" name="id" value={appointment.id} />
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={destructiveButtonAutoClass}>
            {isPending ? "Deleting…" : "Delete Appointment"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
