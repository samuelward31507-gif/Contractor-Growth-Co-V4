"use client";

import { useActionState, useEffect, useRef } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import { createContact, updateContact, type ContactFormState } from "../actions";

const initialState: ContactFormState = {};

export function ContactDialog({
  mode,
  contact,
  onClose,
}: {
  mode: "create" | "edit";
  contact?: Contact;
  onClose: () => void;
}) {
  const action = mode === "create" ? createContact : updateContact;
  const [state, formAction, isPending] = useActionState(action, initialState);
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
          {mode === "create" ? "Add Contact" : "Edit Contact"}
        </h2>

        <form action={formAction} className="mt-4 space-y-4">
          {mode === "edit" && contact ? <input type="hidden" name="id" value={contact.id} /> : null}

          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="firstName" className={labelClass}>
                First name
              </label>
              <input
                id="firstName"
                name="firstName"
                defaultValue={contact?.first_name ?? ""}
                className={inputClass}
                placeholder="Jane"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="lastName" className={labelClass}>
                Last name
              </label>
              <input
                id="lastName"
                name="lastName"
                defaultValue={contact?.last_name ?? ""}
                className={inputClass}
                placeholder="Doe"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="companyName" className={labelClass}>
              Company
            </label>
            <input
              id="companyName"
              name="companyName"
              defaultValue={contact?.company_name ?? ""}
              className={inputClass}
              placeholder="Acme Roofing & Exteriors"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="phone" className={labelClass}>
                Phone
              </label>
              <input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={contact?.phone ?? ""}
                className={inputClass}
                placeholder="(555) 123-4567"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={contact?.email ?? ""}
                className={inputClass}
                placeholder="jane@company.com"
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
              defaultValue={contact?.notes ?? ""}
              className={inputClass}
              placeholder="Anything worth remembering about this contact"
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
            <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
              {isPending
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create Contact"
                  : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
