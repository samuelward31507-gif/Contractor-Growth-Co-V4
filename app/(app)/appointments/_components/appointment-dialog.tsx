"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { APPOINTMENT_STATUSES, type Appointment } from "@/lib/appointments/queries";
import { ContactPicker } from "../../_components/contact-picker";
import { createAppointment, updateAppointment, type AppointmentFormState } from "../actions";
import { LeadPicker } from "./lead-picker";

const initialState: AppointmentFormState = {};

function toDateInputValue(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function toTimeInputValue(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(11, 16);
}

export function AppointmentDialog({
  mode,
  contacts,
  leads,
  appointment,
  onClose,
  defaultDate,
  defaultStartTime,
  defaultEndTime,
}: {
  mode: "create" | "edit";
  contacts: Contact[];
  leads: Lead[];
  appointment?: Appointment;
  onClose: () => void;
  /** Pass 2 (Native Calendar System): prefill for "create" mode only, when opened from a clicked calendar slot ("YYYY-MM-DD"/"HH:MM", the organization's own local wall-clock time - never converted here, the same plain HTML date/time input shape parseAppointmentForm already expects). Ignored in "edit" mode, which always prefills from the real appointment. */
  defaultDate?: string;
  defaultStartTime?: string;
  defaultEndTime?: string;
}) {
  const action = mode === "create" ? createAppointment : updateAppointment;
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [contactId, setContactId] = useState(appointment?.contact_id ?? "");
  const closedRef = useRef(false);

  useEffect(() => {
    // Phase 1 Scheduling Foundation, Stage 5: a successful save that also
    // carries a Google Calendar sync warning stays open (with a manual
    // "Done" affordance below) so the contractor actually sees it, instead
    // of auto-closing the instant it appears - the appointment itself was
    // still saved successfully either way.
    if (state.success && !state.warning && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [state.success, state.warning, onClose]);

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="appointment-dialog-title">
      <DialogTitle id="appointment-dialog-title">
        {mode === "create" ? "Add Appointment" : "Edit Appointment"}
      </DialogTitle>

      <form action={formAction} className="mt-4 space-y-4">
          {mode === "edit" && appointment ? <input type="hidden" name="id" value={appointment.id} /> : null}

          {state.error ? (
            <p className={`flex items-start gap-2 ${errorBannerClass}`} role="alert">
              <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{state.error}</span>
            </p>
          ) : null}

          {state.success && state.warning ? (
            <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-700" role="status">
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{state.warning}</span>
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label className={labelClass}>Contact</label>
            <ContactPicker
              contacts={contacts}
              defaultContact={appointment?.contact ?? null}
              name="contactId"
              onSelect={(contact) => setContactId(contact?.id ?? "")}
            />
          </div>

          <div className="space-y-1.5">
            <label className={labelClass}>Lead</label>
            <LeadPicker leads={leads} contactId={contactId} defaultLeadId={appointment?.lead_id} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="title" className={labelClass}>
              Title
            </label>
            <input
              id="title"
              name="title"
              defaultValue={appointment?.title ?? ""}
              className={inputClass}
              placeholder="e.g. AC Replacement Consultation"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="date" className={labelClass}>
              Date
            </label>
            <input
              id="date"
              name="date"
              type="date"
              defaultValue={appointment ? toDateInputValue(appointment.start_at) : (defaultDate ?? "")}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="startTime" className={labelClass}>
                Start time
              </label>
              <input
                id="startTime"
                name="startTime"
                type="time"
                defaultValue={appointment ? toTimeInputValue(appointment.start_at) : (defaultStartTime ?? "")}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="endTime" className={labelClass}>
                End time
              </label>
              <input
                id="endTime"
                name="endTime"
                type="time"
                defaultValue={appointment ? toTimeInputValue(appointment.end_at) : (defaultEndTime ?? "")}
                className={inputClass}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="status" className={labelClass}>
              Status
            </label>
            <select id="status" name="status" defaultValue={appointment?.status ?? "scheduled"} className={inputClass}>
              {APPOINTMENT_STATUSES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="notes" className={labelClass}>
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              defaultValue={appointment?.notes ?? ""}
              className={inputClass}
              placeholder="Internal notes about this appointment"
            />
          </div>

          <DialogFooter>
            {state.success && state.warning ? (
              <button type="button" onClick={onClose} className={secondaryButtonAutoClass}>
                Done
              </button>
            ) : (
              <>
                <button type="button" onClick={onClose} className={ghostButtonClass}>
                  Cancel
                </button>
                <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
                  {isPending
                    ? mode === "create"
                      ? "Creating…"
                      : "Saving…"
                    : mode === "create"
                      ? "Create Appointment"
                      : "Save Changes"}
                </button>
              </>
            )}
          </DialogFooter>
        </form>
    </Dialog>
  );
}
