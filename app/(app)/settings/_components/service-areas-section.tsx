"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import { X, Plus } from "lucide-react";
import { destructiveButtonAutoClass, errorBannerClass, ghostButtonClass, inputClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { ServiceArea } from "@/lib/settings/queries";
import { createServiceArea, deleteServiceArea, type DeleteState, type SettingsActionState } from "../actions";

const initialCreateState: SettingsActionState = {};
const initialDeleteState: DeleteState = {};

function DeleteAreaDialog({ area, onClose }: { area: ServiceArea; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(deleteServiceArea, initialDeleteState);

  return (
    <Dialog onClose={onClose} labelledBy="delete-area-title">
      <DialogTitle id="delete-area-title">Remove &quot;{area.name}&quot;?</DialogTitle>
      <DialogDescription>This area will no longer be listed as served.</DialogDescription>

      {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

      <form action={formAction}>
        <input type="hidden" name="id" value={area.id} />
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={destructiveButtonAutoClass}>
            {isPending ? "Removing…" : "Remove area"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function ServiceAreasSection({ areas, canEdit }: { areas: ServiceArea[]; canEdit: boolean }) {
  const [state, formAction, isPending] = useActionState(createServiceArea, initialCreateState);
  const [deleting, setDeleting] = useState<ServiceArea | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  return (
    <section>
      <h2 className={subsectionTitleClass}>Service area</h2>
      <p className={`mt-1 ${metaClass}`}>Cities and areas your business serves.</p>

      <div className="mt-4">
        {state.error ? <p className={`mb-4 ${errorBannerClass}`}>{state.error}</p> : null}

        {areas.length === 0 ? (
          <p className="text-sm text-slate-500">No service areas added yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {areas.map((area) => (
              <li
                key={area.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-1 pl-3 pr-1.5 text-sm text-slate-700"
              >
                {area.name}
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setDeleting(area)}
                    aria-label={`Remove ${area.name}`}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <form ref={formRef} action={formAction} className="mt-4 flex gap-2">
            <input type="text" name="name" placeholder="e.g. Colorado Springs" className={`${inputClass} max-w-xs`} />
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="h-4 w-4" aria-hidden />
              {isPending ? "Adding…" : "Add area"}
            </button>
          </form>
        ) : null}
      </div>

      {deleting ? <DeleteAreaDialog area={deleting} onClose={() => setDeleting(null)} /> : null}
    </section>
  );
}
