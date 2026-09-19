"use client";

import { useActionState } from "react";
import { destructiveButtonAutoClass, errorBannerClass, ghostButtonClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { contactDisplayName } from "@/lib/contacts/format";
import type { Contact } from "@/lib/contacts/queries";
import { deleteContact, type DeleteContactState } from "../../actions";

const initialState: DeleteContactState = {};

export function DeleteContactDialog({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(deleteContact, initialState);
  const name = contactDisplayName(contact);

  return (
    <Dialog onClose={onClose} labelledBy="delete-contact-title">
      <DialogTitle id="delete-contact-title">Delete {name}?</DialogTitle>
      <DialogDescription>This will permanently remove this contact.</DialogDescription>

      {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

      <form action={formAction}>
        <input type="hidden" name="id" value={contact.id} />
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={destructiveButtonAutoClass}>
            {isPending ? "Deleting…" : "Delete Contact"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
