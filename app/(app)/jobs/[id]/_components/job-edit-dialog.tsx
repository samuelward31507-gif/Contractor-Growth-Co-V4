"use client";

import { useActionState, useEffect, useRef } from "react";
import { AlertCircle } from "lucide-react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Job } from "@/lib/jobs/queries";
import { updateJob, type UpdateJobFormState } from "../../actions";

const initialState: UpdateJobFormState = {};

/**
 * Phase 1A: edit a job's title, contracted amount, and notes in place.
 * Mirrors app/(app)/jobs/_components/job-dialog.tsx's shape exactly (same
 * useActionState pattern, same field classes) minus the contact/lead
 * pickers - relationships are not editable here by design (see updateJob's
 * own comment). Values are preloaded from the job row; a blank amount
 * clears it rather than writing 0.
 */
export function JobEditDialog({ job, onClose }: { job: Job; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(updateJob, initialState);
  const closedRef = useRef(false);

  useEffect(() => {
    if (state.success && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [state.success, onClose]);

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="job-edit-dialog-title">
      <DialogTitle id="job-edit-dialog-title">Edit Job</DialogTitle>

      <form action={formAction} className="mt-4 space-y-4">
        <input type="hidden" name="id" value={job.id} />

        {state.error ? (
          <p className={`flex items-start gap-2 ${errorBannerClass}`} role="alert">
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor="job-edit-title" className={labelClass}>
            Title
          </label>
          <input id="job-edit-title" name="title" defaultValue={job.title} className={inputClass} placeholder="e.g. Water Heater Replacement" required />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="job-edit-amount" className={labelClass}>
            Amount
          </label>
          <input
            id="job-edit-amount"
            name="amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            defaultValue={job.amount ?? ""}
            className={inputClass}
            placeholder="Leave blank if unknown"
          />
          <p className="text-xs text-slate-500">The contracted amount for this job. Leave blank if it isn&rsquo;t known yet.</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="job-edit-notes" className={labelClass}>
            Notes
          </label>
          <textarea id="job-edit-notes" name="notes" rows={3} defaultValue={job.notes ?? ""} className={inputClass} placeholder="Internal notes about this job" />
        </div>

        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : "Save Changes"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
