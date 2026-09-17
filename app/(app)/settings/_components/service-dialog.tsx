"use client";

import { useActionState, useEffect, useRef } from "react";
import { errorBannerClass, inputClass, labelClass } from "@/lib/ui/form";
import type { Service } from "@/lib/settings/queries";
import { createService, updateService, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

const submitButtonClass =
  "inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400";

export function ServiceDialog({
  mode,
  service,
  onClose,
}: {
  mode: "create" | "edit";
  service?: Service;
  onClose: () => void;
}) {
  const action = mode === "create" ? createService : updateService;
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
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {mode === "create" ? "Add Service" : "Edit Service"}
        </h2>

        <form action={formAction} className="mt-4 space-y-4">
          {mode === "edit" && service ? <input type="hidden" name="id" value={service.id} /> : null}

          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}

          <div className="space-y-1.5">
            <label htmlFor="name" className={labelClass}>
              Name
            </label>
            <input
              id="name"
              name="name"
              defaultValue={service?.name ?? ""}
              className={inputClass}
              placeholder="e.g. AC Repair"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="description" className={labelClass}>
              Description
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={service?.description ?? ""}
              className={inputClass}
              placeholder="A short description a customer or AI assistant could use to understand this service"
            />
          </div>

          {mode === "edit" ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={service?.is_active ?? true}
                className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900/20"
              />
              Active
            </label>
          ) : null}

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
                  ? "Create Service"
                  : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
