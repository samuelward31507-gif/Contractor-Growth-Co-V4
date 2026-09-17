"use client";

import { useActionState } from "react";
import { errorBannerClass, inputClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { cardClass, cardHeaderClass, cardSubtleClass, cardTitleClass } from "@/lib/ui/card";
import { DAYS_OF_WEEK, type BusinessHour, type DayOfWeek } from "@/lib/settings/queries";
import { updateBusinessHours, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

export function BusinessHoursSection({
  hours,
  timezone,
  canEdit,
}: {
  hours: Record<DayOfWeek, BusinessHour>;
  timezone: string;
  canEdit: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateBusinessHours, initialState);

  return (
    <section className={cardClass}>
      <div className={cardHeaderClass}>
        <div>
          <h2 className={cardTitleClass}>Business Hours</h2>
          <p className={`mt-0.5 ${cardSubtleClass}`}>
            Weekly operating schedule, shown in {timezone.replace(/_/g, " ")}.
          </p>
        </div>
      </div>

      <form action={formAction} className="p-5">
        <fieldset disabled={!canEdit || isPending} className="space-y-4">
          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}
          {state.success ? <p className={successBannerClass}>Business hours saved.</p> : null}

          <div className="divide-y divide-slate-100">
            {DAYS_OF_WEEK.map(({ value: day, label }) => {
              const dayHours = hours[day];
              return (
                <div key={day} className="grid grid-cols-1 items-center gap-3 py-3 sm:grid-cols-[8rem_auto_1fr_auto_1fr]">
                  <span className="text-sm font-medium text-slate-900">{label}</span>

                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      name={`${day}_isOpen`}
                      defaultChecked={dayHours.is_open}
                      className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900/20"
                    />
                    Open
                  </label>

                  <input
                    type="time"
                    name={`${day}_open`}
                    defaultValue={dayHours.open_time ?? ""}
                    className={inputClass}
                    aria-label={`${label} opening time`}
                  />

                  <span className="hidden text-center text-xs text-slate-400 sm:block">to</span>

                  <input
                    type="time"
                    name={`${day}_close`}
                    defaultValue={dayHours.close_time ?? ""}
                    className={inputClass}
                    aria-label={`${label} closing time`}
                  />
                </div>
              );
            })}
          </div>

          {canEdit ? (
            <div className="flex justify-end pt-4">
              <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
                {isPending ? "Saving…" : "Save Business Hours"}
              </button>
            </div>
          ) : null}
        </fieldset>
      </form>
    </section>
  );
}
