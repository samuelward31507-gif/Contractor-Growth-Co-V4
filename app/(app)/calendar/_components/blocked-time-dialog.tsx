"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { destructiveGhostButtonAutoClass, errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { BlockedTime } from "@/lib/scheduling/blocked-time";
import { createBlockedTime, updateBlockedTime, deleteBlockedTime, type BlockedTimeFormState, type DeleteBlockedTimeState } from "../actions";

const createInitialState: BlockedTimeFormState = {};
const deleteInitialState: DeleteBlockedTimeState = {};

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
 * Pass 2 (Native Calendar System): create/edit/delete blocked time (Phase
 * 7). One dialog handles both create (opened from the toolbar's "Block
 * Time" button or a clicked empty slot) and edit (opened from an existing
 * block on the calendar) - the same mode split AppointmentDialog already
 * uses.
 */
export function BlockedTimeDialog({
  mode,
  blockedTime,
  timeZone,
  defaultDate,
  defaultStartTime,
  defaultEndTime,
  onClose,
}: {
  mode: "create" | "edit";
  blockedTime?: BlockedTime;
  timeZone?: string;
  defaultDate?: string;
  defaultStartTime?: string;
  defaultEndTime?: string;
  onClose: () => void;
}) {
  const action = mode === "create" ? createBlockedTime : updateBlockedTime;
  const [state, formAction, isPending] = useActionState(action, createInitialState);
  const [deleteState, deleteFormAction, isDeleting] = useActionState(deleteBlockedTime, deleteInitialState);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteSubmitted, setDeleteSubmitted] = useState(false);
  const closedRef = useRef(false);

  useEffect(() => {
    if (state.success && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [state.success, onClose]);

  useEffect(() => {
    if (deleteSubmitted && !isDeleting && !deleteState?.error && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [deleteSubmitted, isDeleting, deleteState, onClose]);

  return (
    <Dialog onClose={onClose} labelledBy="blocked-time-dialog-title">
      <DialogTitle id="blocked-time-dialog-title">{mode === "create" ? "Block Time" : "Edit Blocked Time"}</DialogTitle>

      <form action={formAction} className="mt-4 space-y-4">
        {mode === "edit" && blockedTime ? <input type="hidden" name="id" value={blockedTime.id} /> : null}

        {state.error ? (
          <p className={`flex items-start gap-2 ${errorBannerClass}`} role="alert">
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor="blocked-date" className={labelClass}>
            Date
          </label>
          <input
            id="blocked-date"
            name="date"
            type="date"
            defaultValue={blockedTime ? toDateInputValue(blockedTime.start_at, timeZone) : (defaultDate ?? "")}
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="blocked-start" className={labelClass}>
              Start time
            </label>
            <input
              id="blocked-start"
              name="startTime"
              type="time"
              defaultValue={blockedTime ? toTimeInputValue(blockedTime.start_at, timeZone) : (defaultStartTime ?? "")}
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="blocked-end" className={labelClass}>
              End time
            </label>
            <input
              id="blocked-end"
              name="endTime"
              type="time"
              defaultValue={blockedTime ? toTimeInputValue(blockedTime.end_at, timeZone) : (defaultEndTime ?? "")}
              className={inputClass}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="blocked-reason" className={labelClass}>
            Reason (optional)
          </label>
          <input
            id="blocked-reason"
            name="reason"
            defaultValue={blockedTime?.reason ?? ""}
            placeholder="e.g. Lunch, Personal time, Travel"
            className={inputClass}
          />
        </div>

        <DialogFooter>
          {mode === "edit" && blockedTime ? (
            confirmingDelete ? (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setConfirmingDelete(false)} className={ghostButtonClass}>
                  Keep
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => {
                    setDeleteSubmitted(true);
                    const formData = new FormData();
                    formData.set("id", blockedTime.id);
                    deleteFormAction(formData);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
                >
                  {isDeleting ? "Removing…" : "Remove"}
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmingDelete(true)} className={destructiveGhostButtonAutoClass}>
                Remove block
              </button>
            )
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            <button type="button" onClick={onClose} className={ghostButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
              {isPending ? "Saving…" : mode === "create" ? "Block Time" : "Save Changes"}
            </button>
          </div>
        </DialogFooter>
        {deleteState?.error ? <p className={`mt-2 ${errorBannerClass}`}>{deleteState.error}</p> : null}
      </form>
    </Dialog>
  );
}
