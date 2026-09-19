"use client";

import { useActionState, useEffect, useRef } from "react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Service } from "@/lib/settings/queries";
import { createService, updateService, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

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
    <Dialog onClose={onClose} className="max-w-md" labelledBy="service-dialog-title">
      <DialogTitle id="service-dialog-title">{mode === "create" ? "Add Service" : "Edit Service"}</DialogTitle>

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
                  ? "Create Service"
                  : "Save Changes"}
            </button>
          </DialogFooter>
        </form>
    </Dialog>
  );
}
