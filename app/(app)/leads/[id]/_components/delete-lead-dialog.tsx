"use client";

import { useActionState } from "react";
import { destructiveButtonAutoClass, errorBannerClass, ghostButtonClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { contactDisplayName } from "@/lib/contacts/format";
import type { Lead } from "@/lib/leads/queries";
import { deleteLead, type DeleteLeadState } from "../../actions";

const initialState: DeleteLeadState = {};

export function DeleteLeadDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(deleteLead, initialState);
  const who = lead.contact ? contactDisplayName(lead.contact) : "this contact";

  return (
    <Dialog onClose={onClose} labelledBy="delete-lead-title">
      <DialogTitle id="delete-lead-title">Delete this lead?</DialogTitle>
      <DialogDescription>
        This will permanently remove the {lead.service ? `"${lead.service}"` : ""} opportunity for {who}. The
        contact itself will not be affected.
      </DialogDescription>

      {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

      <form action={formAction}>
        <input type="hidden" name="id" value={lead.id} />
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={destructiveButtonAutoClass}>
            {isPending ? "Deleting…" : "Delete Lead"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
