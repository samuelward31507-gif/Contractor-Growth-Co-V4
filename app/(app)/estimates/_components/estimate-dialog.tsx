"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import type { Estimate } from "@/lib/estimates/queries";
import { ContactPicker } from "../../_components/contact-picker";
import { LeadPicker } from "../../appointments/_components/lead-picker";
import { createEstimate, updateEstimate, type EstimateFormState } from "../actions";

const initialState: EstimateFormState = {};

function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

export function EstimateDialog({
  mode,
  contacts,
  leads,
  estimate,
  onClose,
}: {
  mode: "create" | "edit";
  contacts: Contact[];
  leads: Lead[];
  estimate?: Estimate;
  onClose: () => void;
}) {
  const action = mode === "create" ? createEstimate : updateEstimate;
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [contactId, setContactId] = useState(estimate?.contact_id ?? "");
  const closedRef = useRef(false);

  useEffect(() => {
    if (state.success && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [state.success, onClose]);

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="estimate-dialog-title">
      <DialogTitle id="estimate-dialog-title">{mode === "create" ? "New Estimate" : "Edit Estimate"}</DialogTitle>

      <form action={formAction} className="mt-4 space-y-4">
          {mode === "edit" && estimate ? <input type="hidden" name="id" value={estimate.id} /> : null}

          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}

          <div className="space-y-1.5">
            <label className={labelClass}>Contact</label>
            <ContactPicker
              contacts={contacts}
              defaultContact={estimate?.contact ?? null}
              name="contactId"
              onSelect={(contact) => setContactId(contact?.id ?? "")}
            />
          </div>

          <div className="space-y-1.5">
            <label className={labelClass}>Lead</label>
            <LeadPicker leads={leads} contactId={contactId} defaultLeadId={estimate?.lead_id} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="title" className={labelClass}>
              Title
            </label>
            <input
              id="title"
              name="title"
              defaultValue={estimate?.title ?? ""}
              className={inputClass}
              placeholder="e.g. AC Replacement"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="amount" className={labelClass}>
                Amount
              </label>
              <input
                id="amount"
                name="amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                defaultValue={estimate?.amount ?? ""}
                className={inputClass}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="expiresAt" className={labelClass}>
                Expires
              </label>
              <input
                id="expiresAt"
                name="expiresAt"
                type="date"
                defaultValue={estimate?.expires_at ? toDateInputValue(estimate.expires_at) : ""}
                className={inputClass}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="notes" className={labelClass}>
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              defaultValue={estimate?.notes ?? ""}
              className={inputClass}
              placeholder="Internal notes about this estimate"
            />
          </div>

          <DialogFooter>
            <button type="button" onClick={onClose} className={ghostButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
              {isPending
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create Estimate"
                  : "Save Changes"}
            </button>
          </DialogFooter>
        </form>
    </Dialog>
  );
}
