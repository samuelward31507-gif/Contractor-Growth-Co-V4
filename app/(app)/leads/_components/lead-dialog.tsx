"use client";

import { useActionState, useEffect, useRef } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import { LEAD_STATUSES, LEAD_TEMPERATURES, type Lead } from "@/lib/leads/queries";
import { createLead, updateLead, type LeadFormState } from "../actions";
import { ContactPicker } from "../../_components/contact-picker";

const initialState: LeadFormState = {};

const SOURCE_SUGGESTIONS = ["Google", "Facebook", "Referral", "Website", "Phone", "Other"];

export function LeadDialog({
  mode,
  contacts,
  lead,
  onClose,
}: {
  mode: "create" | "edit";
  contacts: Contact[];
  lead?: Lead;
  onClose: () => void;
}) {
  const action = mode === "create" ? createLead : updateLead;
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
          {mode === "create" ? "Add Lead" : "Edit Lead"}
        </h2>

        <form action={formAction} className="mt-4 space-y-4">
          {mode === "edit" && lead ? <input type="hidden" name="id" value={lead.id} /> : null}

          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}

          <div className="space-y-1.5">
            <label className={labelClass}>Contact</label>
            <ContactPicker contacts={contacts} defaultContact={lead?.contact ?? null} name="contactId" />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="service" className={labelClass}>
              Service
            </label>
            <input
              id="service"
              name="service"
              defaultValue={lead?.service ?? ""}
              className={inputClass}
              placeholder="e.g. AC Replacement"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="status" className={labelClass}>
                Status
              </label>
              <select id="status" name="status" defaultValue={lead?.status ?? "new"} className={inputClass}>
                {LEAD_STATUSES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="temperature" className={labelClass}>
                Temperature
              </label>
              <select
                id="temperature"
                name="temperature"
                defaultValue={lead?.temperature ?? "cold"}
                className={inputClass}
              >
                {LEAD_TEMPERATURES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="source" className={labelClass}>
                Source
              </label>
              <input
                id="source"
                name="source"
                list="lead-source-options"
                defaultValue={lead?.source ?? ""}
                className={inputClass}
                placeholder="e.g. Google"
              />
              <datalist id="lead-source-options">
                {SOURCE_SUGGESTIONS.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="estimatedValue" className={labelClass}>
                Estimated value
              </label>
              <input
                id="estimatedValue"
                name="estimatedValue"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                defaultValue={lead?.estimated_value ?? ""}
                className={inputClass}
                placeholder="0.00"
              />
            </div>
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
                  ? "Create Lead"
                  : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
