"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { errorBannerClass, inputClass, labelClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { APPOINTMENT_STATUSES, type Appointment } from "@/lib/appointments/queries";
import { ContactPicker } from "../../_components/contact-picker";
import { createAppointment, updateAppointment, type AppointmentFormState } from "../actions";
import { LeadPicker } from "./lead-picker";

const initialState: AppointmentFormState = {};

const submitButtonClass =
  "inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400";

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
}: {
  mode: "create" | "edit";
  contacts: Contact[];
  leads: Lead[];
  appointment?: Appointment;
  onClose: () => void;
}) {
  const action = mode === "create" ? createAppointment : updateAppointment;
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [contactId, setContactId] = useState(appointment?.contact_id ?? "");
  const closedRef = useRef(false);

  useEffect(() => {
    if (state.success && !closedRef.current) {
      closedRef.current = true;
      onClose();
    }
  }, [state.success, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
      />
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {mode === "create" ? "Add Appointment" : "Edit Appointment"}
        </h2>

        <form action={formAction} className="mt-4 space-y-4">
          {mode === "edit" && appointment ? <input type="hidden" name="id" value={appointment.id} /> : null}

          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}

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
              defaultValue={appointment ? toDateInputValue(appointment.start_at) : ""}
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
                defaultValue={appointment ? toTimeInputValue(appointment.start_at) : ""}
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
                defaultValue={appointment ? toTimeInputValue(appointment.end_at) : ""}
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

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
            >
              Cancel
            </button>
            <button type="submit" disabled={isPending} className={submitButtonClass}>
              {isPending
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create Appointment"
                  : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
