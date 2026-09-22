"use client";

import { useActionState } from "react";
import { Calendar } from "lucide-react";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { errorBannerClass, successBannerClass, primaryButtonAutoClass, secondaryButtonAutoClass, destructiveButtonAutoClass, inputClass, labelClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import type { SafeCalendarConnection } from "@/lib/calendar/connection";
import type { CalendarListItem } from "@/lib/calendar/provider";
import { selectCalendarAction, disconnectCalendarAction, checkCalendarHealthAction, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

const STATUS_TONE: Record<SafeCalendarConnection["status"], BadgeTone> = {
  connected: "success",
  error: "warning",
  disconnected: "neutral",
};

const STATUS_LABEL: Record<SafeCalendarConnection["status"], string> = {
  connected: "Connected",
  error: "Needs attention",
  disconnected: "Disconnected",
};

/**
 * Phase 1 Scheduling Foundation, Stage 3. Extends the existing "Operations"
 * Settings group (see app/(app)/settings/page.tsx) rather than introducing
 * a new page/route - matching booking-settings-section.tsx/
 * business-hours-section.tsx's own established shape exactly (useActionState
 * + the shared lib/ui/form.ts primitives).
 *
 * "Change calendar" is deliberately reached via Disconnect + reconnect,
 * not a separate in-place picker - an in-place picker would need a live
 * Google API call on every single Settings page load for an already-fully-
 * configured organization just in case the contractor wants to change it;
 * disconnect+reconnect reuses the exact same one-time "list calendars right
 * after connecting" flow below with no additional code path, at the cost
 * of one extra click for the (expected to be rare) case of actually
 * switching calendars.
 */
export function CalendarConnectionSection({
  connection,
  availableCalendars,
  canEdit,
}: {
  connection: SafeCalendarConnection | null;
  availableCalendars: CalendarListItem[];
  canEdit: boolean;
}) {
  const [selectState, selectFormAction, isSelecting] = useActionState(selectCalendarAction, initialState);
  const [disconnectState, disconnectFormAction, isDisconnecting] = useActionState(disconnectCalendarAction, initialState);
  const [healthState, healthFormAction, isCheckingHealth] = useActionState(checkCalendarHealthAction, initialState);

  return (
    <section>
      <h2 className={subsectionTitleClass}>Calendar</h2>
      <p className={`mt-1 ${metaClass}`}>Connect Google Calendar so scheduling can check real availability and keep your calendar in sync.</p>

      <div className="mt-5 space-y-4">
        {!connection ? (
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3.5">
            <div className="flex items-center gap-2.5 text-sm text-slate-600">
              <Calendar className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              No calendar connected yet.
            </div>
            {canEdit ? (
              <a href="/api/calendar/oauth/start" className={primaryButtonAutoClass}>
                Connect Google Calendar
              </a>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4 rounded-lg border border-slate-200 px-4 py-3.5">
            {disconnectState.error ? <p className={errorBannerClass}>{disconnectState.error}</p> : null}
            {selectState.error ? <p className={errorBannerClass}>{selectState.error}</p> : null}
            {selectState.success ? <p className={successBannerClass}>Calendar selection saved.</p> : null}
            {healthState.error ? <p className={errorBannerClass}>{healthState.error}</p> : null}
            {healthState.success ? <p className={successBannerClass}>Calendar connection is healthy.</p> : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[connection.status]}>{STATUS_LABEL[connection.status]}</Badge>
                  {connection.accountEmail ? <span className="text-slate-600">{connection.accountEmail}</span> : null}
                </div>
                {connection.calendarName ? <p className={metaClass}>Using calendar: {connection.calendarName}</p> : null}
                {connection.lastSyncedAt ? <p className={metaClass}>Last checked {new Date(connection.lastSyncedAt).toLocaleString()}</p> : null}
                {connection.status === "error" && connection.lastError ? <p className="text-xs text-amber-700">{connection.lastError}</p> : null}
              </div>

              {canEdit ? (
                <div className="flex items-center gap-2">
                  <form action={healthFormAction}>
                    <button type="submit" disabled={isCheckingHealth} className={secondaryButtonAutoClass}>
                      {isCheckingHealth ? "Checking…" : "Check connection"}
                    </button>
                  </form>
                  <form action={disconnectFormAction}>
                    <button type="submit" disabled={isDisconnecting} className={destructiveButtonAutoClass}>
                      {isDisconnecting ? "Disconnecting…" : "Disconnect"}
                    </button>
                  </form>
                </div>
              ) : null}
            </div>

            {canEdit && !connection.calendarId ? (
              <form action={selectFormAction} className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
                <div className="min-w-[220px] space-y-1.5">
                  <label htmlFor="calendarId" className={labelClass}>
                    Choose a calendar
                  </label>
                  {availableCalendars.length > 0 ? (
                    <select
                      id="calendarId"
                      name="calendarId"
                      className={inputClass}
                      onChange={(event) => {
                        const option = event.currentTarget.selectedOptions[0];
                        const hiddenNameField = event.currentTarget.form?.elements.namedItem("calendarName");
                        if (hiddenNameField && "value" in hiddenNameField) hiddenNameField.value = option?.text ?? "";
                      }}
                    >
                      {availableCalendars.map((calendar) => (
                        <option key={calendar.id} value={calendar.id}>
                          {calendar.name}
                          {calendar.primary ? " (primary)" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className={metaClass}>We couldn&apos;t load your calendars right now. Try checking the connection above.</p>
                  )}
                  <input type="hidden" name="calendarName" defaultValue={availableCalendars[0]?.name ?? ""} />
                </div>
                {availableCalendars.length > 0 ? (
                  <button type="submit" disabled={isSelecting} className={primaryButtonAutoClass}>
                    {isSelecting ? "Saving…" : "Use this calendar"}
                  </button>
                ) : null}
              </form>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
