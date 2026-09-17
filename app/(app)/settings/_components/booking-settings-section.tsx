"use client";

import { useActionState } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { cardClass, cardHeaderClass, cardSubtleClass, cardTitleClass } from "@/lib/ui/card";
import type { BookingSettings } from "@/lib/settings/queries";
import { updateBookingSettings, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

export function BookingSettingsSection({
  settings,
  canEdit,
}: {
  settings: BookingSettings;
  canEdit: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateBookingSettings, initialState);

  return (
    <section className={cardClass}>
      <div className={cardHeaderClass}>
        <div>
          <h2 className={cardTitleClass}>Booking</h2>
          <p className={`mt-0.5 ${cardSubtleClass}`}>Rules for automated appointment booking, once it&apos;s built.</p>
        </div>
      </div>

      <form action={formAction} className="p-5">
        <fieldset disabled={!canEdit || isPending} className="space-y-4">
          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}
          {state.success ? <p className={successBannerClass}>Booking settings saved.</p> : null}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              name="bookingEnabled"
              defaultChecked={settings.booking_enabled}
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900/20"
            />
            Allow the system to schedule appointments automatically when booking is available
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <label htmlFor="minimumNoticeMinutes" className={labelClass}>
                Minimum notice
              </label>
              <p className={cardSubtleClass}>How far in advance a customer must book.</p>
              <div className="relative">
                <input
                  id="minimumNoticeMinutes"
                  name="minimumNoticeMinutes"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={settings.minimum_notice_minutes}
                  className={inputClass}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                  minutes
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="defaultDurationMinutes" className={labelClass}>
                Default appointment duration
              </label>
              <p className={cardSubtleClass}>Default length of a new appointment.</p>
              <div className="relative">
                <input
                  id="defaultDurationMinutes"
                  name="defaultDurationMinutes"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={settings.default_duration_minutes}
                  className={inputClass}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                  minutes
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="bufferMinutes" className={labelClass}>
                Buffer between appointments
              </label>
              <p className={cardSubtleClass}>Time to leave open between appointments.</p>
              <div className="relative">
                <input
                  id="bufferMinutes"
                  name="bufferMinutes"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={settings.buffer_minutes}
                  className={inputClass}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                  minutes
                </span>
              </div>
            </div>
          </div>

          {canEdit ? (
            <div className="flex justify-end pt-2">
              <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
                {isPending ? "Saving…" : "Save Booking Settings"}
              </button>
            </div>
          ) : null}
        </fieldset>
      </form>
    </section>
  );
}
