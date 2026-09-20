"use client";

import { useActionState } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import { LEAD_SOURCE_OPTIONS, type BusinessProfile } from "@/lib/settings/queries";
import { updateOperationsDetail, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

export function OperationsDetailSection({
  profile,
  canEdit,
}: {
  profile: Pick<BusinessProfile, "emergency_service" | "after_hours_handling" | "estimate_process" | "lead_sources">;
  canEdit: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateOperationsDetail, initialState);
  const selectedSources = new Set(profile.lead_sources ?? []);

  return (
    <section>
      <h2 className={subsectionTitleClass}>Operations detail</h2>
      <p className={`mt-1 ${metaClass}`}>How your business handles emergencies, after-hours contact, and estimates.</p>

      <form action={formAction} className="mt-5">
        <fieldset disabled={!canEdit || isPending} className="space-y-4">
          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}
          {state.success ? <p className={successBannerClass}>Operations details saved.</p> : null}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              name="emergencyService"
              defaultChecked={profile.emergency_service}
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900/20"
            />
            We offer emergency service
          </label>

          <div className="space-y-1.5">
            <label htmlFor="afterHoursHandling" className={labelClass}>
              After-hours handling
            </label>
            <p className={metaClass}>What happens when a customer reaches out outside business hours.</p>
            <textarea
              id="afterHoursHandling"
              name="afterHoursHandling"
              rows={2}
              defaultValue={profile.after_hours_handling ?? ""}
              className={inputClass}
              placeholder="e.g. Voicemail after hours, we call back the next business day."
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="estimateProcess" className={labelClass}>
              Estimate process
            </label>
            <p className={metaClass}>How you typically provide estimates to customers.</p>
            <textarea
              id="estimateProcess"
              name="estimateProcess"
              rows={2}
              defaultValue={profile.estimate_process ?? ""}
              className={inputClass}
              placeholder="e.g. Free in-home estimates, usually within 48 hours."
            />
          </div>

          <div className="space-y-1.5">
            <span className={labelClass}>Lead sources</span>
            <p className={metaClass}>Where your leads currently come from.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {LEAD_SOURCE_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="leadSources"
                    value={option.value}
                    defaultChecked={selectedSources.has(option.value)}
                    className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900/20"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>

          {canEdit ? (
            <div className="flex justify-end pt-2">
              <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
                {isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          ) : null}
        </fieldset>
      </form>
    </section>
  );
}
