"use client";

import { useActionState } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import type { NotificationSettings } from "@/lib/settings/queries";
import { updateNotificationSettings, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

const TOGGLES: { name: string; key: keyof NotificationSettings; label: string; description: string }[] = [
  {
    name: "notifyOnHotLead",
    key: "notify_on_hot_lead",
    label: "Notify on hot lead",
    description: "When a lead is marked hot.",
  },
  {
    name: "notifyOnAiEscalation",
    key: "notify_on_ai_escalation",
    label: "Notify on AI escalation",
    description: "When AI hands a conversation off to your team.",
  },
  {
    name: "notifyOnMissedCall",
    key: "notify_on_missed_call",
    label: "Notify on missed call",
    description: "When a customer call is missed.",
  },
  {
    name: "notifyOnAppointmentBooked",
    key: "notify_on_appointment_booked",
    label: "Notify on appointment booked",
    description: "When a new appointment is scheduled.",
  },
];

export function NotificationSettingsSection({
  settings,
  canEdit,
}: {
  settings: NotificationSettings;
  canEdit: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateNotificationSettings, initialState);

  return (
    <section>
      <h2 className={subsectionTitleClass}>Notifications &amp; escalation</h2>
      <p className={`mt-1 ${metaClass}`}>
        Where important events are surfaced, and who is the human escalation contact when AI hands off a conversation.
      </p>

      <form action={formAction} className="mt-5">
        <fieldset disabled={!canEdit || isPending} className="space-y-4">
          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}
          {state.success ? <p className={successBannerClass}>Notification preferences saved.</p> : null}

          <div className="space-y-1.5">
            <label htmlFor="escalationContactName" className={labelClass}>
              Human escalation contact
            </label>
            <input
              id="escalationContactName"
              name="escalationContactName"
              defaultValue={settings.escalation_contact_name ?? ""}
              className={inputClass}
              placeholder="Jamie Rivera"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="notificationEmail" className={labelClass}>
                Notification email
              </label>
              <input
                id="notificationEmail"
                name="notificationEmail"
                type="email"
                defaultValue={settings.notification_email ?? ""}
                className={inputClass}
                placeholder="alerts@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="notificationPhone" className={labelClass}>
                Notification phone
              </label>
              <input
                id="notificationPhone"
                name="notificationPhone"
                type="tel"
                defaultValue={settings.notification_phone ?? ""}
                className={inputClass}
                placeholder="(555) 123-4567"
              />
            </div>
          </div>

          <div className="space-y-3 pt-2">
            {TOGGLES.map((toggle) => (
              <label key={toggle.name} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  name={toggle.name}
                  defaultChecked={settings[toggle.key] as boolean}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900/20"
                />
                <span>
                  <span className="block font-medium text-slate-900">{toggle.label}</span>
                  <span className="block text-xs text-slate-500">{toggle.description}</span>
                </span>
              </label>
            ))}
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
