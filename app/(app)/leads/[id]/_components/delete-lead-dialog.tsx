"use client";

import { useActionState } from "react";
import { errorBannerClass } from "@/lib/ui/form";
import { contactDisplayName } from "@/lib/contacts/format";
import type { Lead } from "@/lib/leads/queries";
import { deleteLead, type DeleteLeadState } from "../../actions";

const initialState: DeleteLeadState = {};

export function DeleteLeadDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(deleteLead, initialState);
  const who = lead.contact ? contactDisplayName(lead.contact) : "this contact";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Delete this lead?</h2>
        <p className="mt-2 text-sm text-slate-500">
          This will permanently remove the {lead.service ? `"${lead.service}"` : ""} opportunity for{" "}
          {who}. The contact itself will not be affected.
        </p>

        {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}

        <form action={formAction} className="mt-5 flex items-center justify-end gap-3">
          <input type="hidden" name="id" value={lead.id} />
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
            {isPending ? "Deleting…" : "Delete Lead"}
          </button>
        </form>
      </div>
    </div>
  );
}
