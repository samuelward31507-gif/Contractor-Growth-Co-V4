"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import { X, Plus } from "lucide-react";
import { errorBannerClass, inputClass } from "@/lib/ui/form";
import type { ServiceArea } from "@/lib/settings/queries";
import { createServiceArea, deleteServiceArea, type DeleteState, type SettingsActionState } from "../actions";

const initialCreateState: SettingsActionState = {};
const initialDeleteState: DeleteState = {};

function DeleteAreaDialog({ area, onClose }: { area: ServiceArea; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(deleteServiceArea, initialDeleteState);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Remove &quot;{area.name}&quot;?</h2>
        <p className="mt-2 text-sm text-slate-500">This area will no longer be listed as served.</p>

        {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

        <form action={formAction} className="mt-5 flex items-center justify-end gap-3">
          <input type="hidden" name="id" value={area.id} />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
          >
            {isPending ? "Removing…" : "Remove area"}
          </button>
        </form>
      </div>
    </div>
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
