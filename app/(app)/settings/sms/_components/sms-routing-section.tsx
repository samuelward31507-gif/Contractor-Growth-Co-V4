"use client";

import { useActionState, useState } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { updateSmsPhoneNumber, clearSmsPhoneNumber, type SmsRoutingActionState } from "../actions";

// Inlined rather than imported: lib/ui/card.ts (the shared card primitives
// used by every other settings section) has been removed as part of the
// in-progress Trackpr 2.0 redesign and is not on disk in this working tree.
// These are the exact values from the last committed version of that file,
// kept local to this route so it builds and renders correctly independent
// of the redesign's completion state, per this feature's explicit isolation
// requirement.
const cardClass = "rounded-xl border border-slate-200 bg-white shadow-sm";
const cardHeaderClass = "flex items-center justify-between border-b border-slate-100 px-5 py-4";
const cardTitleClass = "text-sm font-semibold text-slate-900";
const cardSubtleClass = "text-xs text-slate-500";

const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400";

const initialState: SmsRoutingActionState = {};

export function SmsRoutingSection({
  smsPhoneNumber,
  canEdit,
}: {
  smsPhoneNumber: string | null;
  canEdit: boolean;
}) {
  const [saveState, saveAction, isSaving] = useActionState(updateSmsPhoneNumber, initialState);
  const [clearState, clearAction, isClearing] = useActionState(clearSmsPhoneNumber, initialState);
  const [pendingValue, setPendingValue] = useState(smsPhoneNumber ?? "");

  const isPending = isSaving || isClearing;
  const isConfigured = Boolean(smsPhoneNumber);

  return (
    <section className={cardClass}>
      <div className={cardHeaderClass}>
        <div>
          <h2 className={cardTitleClass}>SMS &amp; Communications</h2>
          <p className={`mt-0.5 ${cardSubtleClass}`}>Configure the number customers text to reach your business.</p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
            isConfigured ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {isConfigured ? "Configured" : "Not configured"}
        </span>
      </div>

      <div className="p-5">
        {!canEdit ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
            You have read-only access. Only owners and admins can change this setting.
          </p>
        ) : null}

        <form action={saveAction} className={canEdit ? "space-y-4" : "mt-4 space-y-4 opacity-60"}>
          <fieldset disabled={!canEdit || isPending} className="space-y-4">
            {saveState.error ? <p className={errorBannerClass}>{saveState.error}</p> : null}
            {saveState.success ? <p className={successBannerClass}>SMS number saved.</p> : null}
            {saveState.auditWarning ? <p className={errorBannerClass}>{saveState.auditWarning}</p> : null}

            <div className="space-y-1.5">
              <label htmlFor="smsPhoneNumber" className={labelClass}>
                Trackpr SMS number
              </label>
              <p className="text-xs text-slate-500">This is the Trackpr phone number customers text when replying to your business.</p>
              <input
                id="smsPhoneNumber"
                name="smsPhoneNumber"
                type="tel"
                inputMode="tel"
                value={pendingValue}
                onChange={(event) => setPendingValue(event.target.value)}
                placeholder="+15551234567"
                aria-describedby="smsPhoneNumber-hint"
                className={inputClass}
              />
              <p id="smsPhoneNumber-hint" className="text-xs text-slate-400">
                E.164 format, example: +15551234567
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button type="submit" className={primaryButtonAutoClass}>
                {isSaving ? "Saving..." : "Save"}
              </button>
              {isConfigured ? (
                <button
                  type="submit"
                  formAction={clearAction}
                  disabled={!canEdit || isPending}
                  className={secondaryButtonClass}
                  onClick={() => setPendingValue("")}
                >
                  {isClearing ? "Clearing..." : "Clear number"}
                </button>
              ) : null}
            </div>
          </fieldset>
        </form>

        {clearState.error ? <p className={`mt-3 ${errorBannerClass}`}>{clearState.error}</p> : null}
        {clearState.success ? <p className={`mt-3 ${successBannerClass}`}>SMS number cleared.</p> : null}
        {clearState.auditWarning ? <p className={`mt-3 ${errorBannerClass}`}>{clearState.auditWarning}</p> : null}
      </div>
    </section>
  );
}
