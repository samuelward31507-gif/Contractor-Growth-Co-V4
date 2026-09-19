"use client";

import { useActionState } from "react";
import { destructiveButtonAutoClass, errorBannerClass, ghostButtonClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Service } from "@/lib/settings/queries";
import { deleteService, type DeleteState } from "../actions";

const initialState: DeleteState = {};

export function DeleteServiceDialog({ service, onClose }: { service: Service; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(deleteService, initialState);

  return (
    <Dialog onClose={onClose} labelledBy="delete-service-title">
      <DialogTitle id="delete-service-title">Delete &quot;{service.name}&quot;?</DialogTitle>
      <DialogDescription>This will permanently remove this service.</DialogDescription>

      {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

      <form action={formAction}>
        <input type="hidden" name="id" value={service.id} />
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={destructiveButtonAutoClass}>
            {isPending ? "Deleting…" : "Delete Service"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
