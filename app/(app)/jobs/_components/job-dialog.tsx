"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { ContactPicker } from "../../_components/contact-picker";
import { LeadPicker } from "../../appointments/_components/lead-picker";
import { createJob, type CreateJobFormState } from "../actions";

const initialState: CreateJobFormState = {};

/**
 * Growth System Completion Pass 1: the smallest clean UI for direct job
 * creation - mirrors app/(app)/appointments/_components/appointment-dialog.tsx's
 * shape exactly (same useActionState pattern, same picker components), with
 * no date/time/status fields (a directly-created job always starts
 * 'scheduled', exactly like a job created from an accepted estimate).
 */
export function JobDialog({ contacts, leads, onClose }: { contacts: Contact[]; leads: Lead[]; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(createJob, initialState);
  const [contactId, setContactId] = useState("");
  const closedRef = useRef(false);

  useEffect(() => {
    if (state.success && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [state.success, onClose]);

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="job-dialog-title">
      <DialogTitle id="job-dialog-title">New Job</DialogTitle>

      <form action={formAction} className="mt-4 space-y-4">
        {state.error ? (
          <p className={`flex items-start gap-2 ${errorBannerClass}`} role="alert">
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}

        <div className="space-y-1.5">
          <label className={labelClass}>Contact</label>
          <ContactPicker contacts={contacts} name="contactId" onSelect={(contact) => setContactId(contact?.id ?? "")} />
        </div>

        <div className="space-y-1.5">
          <label className={labelClass}>Lead</label>
          <LeadPicker leads={leads} contactId={contactId} />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="job-title" className={labelClass}>
            Title
          </label>
          <input id="job-title" name="title" className={inputClass} placeholder="e.g. Water Heater Replacement" />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="job-amount" className={labelClass}>
            Amount
          </label>
          <input id="job-amount" name="amount" type="number" min="0" step="0.01" className={inputClass} placeholder="Optional" />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="job-notes" className={labelClass}>
            Notes
          </label>
          <textarea id="job-notes" name="notes" rows={3} className={inputClass} placeholder="Internal notes about this job" />
        </div>

        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Creating…" : "Create Job"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
