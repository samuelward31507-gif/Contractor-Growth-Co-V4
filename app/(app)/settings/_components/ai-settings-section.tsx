"use client";

import { useActionState } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { cardClass, cardHeaderClass, cardSubtleClass, cardTitleClass } from "@/lib/ui/card";
import { AI_TONE_OPTIONS, type AiSettings } from "@/lib/settings/queries";
import { updateAiSettings, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

export function AiSettingsSection({ settings, canEdit }: { settings: AiSettings; canEdit: boolean }) {
  const [state, formAction, isPending] = useActionState(updateAiSettings, initialState);

  return (
    <section className={cardClass}>
      <div className={cardHeaderClass}>
        <div>
          <h2 className={cardTitleClass}>AI & Communication</h2>
          <p className={`mt-0.5 ${cardSubtleClass}`}>
            How AI should represent and communicate for your business, once it&apos;s connected.
          </p>
        </div>
      </div>

      <form action={formAction} className="p-5">
        <fieldset disabled={!canEdit || isPending} className="space-y-4">
          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}
          {state.success ? <p className={successBannerClass}>AI settings saved.</p> : null}

          <div className="rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-2.5 text-xs text-blue-700">
            These settings only store configuration. No AI is connected yet - future automation will read these
            rules once it&apos;s built.
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              name="aiEnabled"
              defaultChecked={settings.ai_enabled}
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900/20"
            />
            Allow AI to represent this business once connected
          </label>

          <div className="space-y-1.5">
            <label htmlFor="tone" className={labelClass}>
              AI tone
            </label>
            <select id="tone" name="tone" defaultValue={settings.tone ?? ""} className={inputClass}>
              <option value="">Not set</option>
              {AI_TONE_OPTIONS.map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="businessIntroduction" className={labelClass}>
              Business introduction
            </label>
            <p className={cardSubtleClass}>How the AI should introduce your business to a customer.</p>
            <textarea
              id="businessIntroduction"
              name="businessIntroduction"
              rows={2}
              defaultValue={settings.business_introduction ?? ""}
              className={inputClass}
              placeholder="e.g. Thanks for reaching out to Acme Roofing & Exteriors!"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="generalInstructions" className={labelClass}>
              General instructions
            </label>
            <p className={cardSubtleClass}>General guidance for how AI should handle customer conversations.</p>
            <textarea
              id="generalInstructions"
              name="generalInstructions"
              rows={3}
              defaultValue={settings.general_instructions ?? ""}
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="emergencyInstructions" className={labelClass}>
              Emergency handling instructions
            </label>
            <p className={cardSubtleClass}>What AI should do if a customer describes an urgent situation.</p>
            <textarea
              id="emergencyInstructions"
              name="emergencyInstructions"
              rows={2}
              defaultValue={settings.emergency_instructions ?? ""}
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="escalationInstructions" className={labelClass}>
              Human escalation instructions
            </label>
            <p className={cardSubtleClass}>When AI should hand a conversation off to your team.</p>
            <textarea
              id="escalationInstructions"
              name="escalationInstructions"
              rows={2}
              defaultValue={settings.escalation_instructions ?? ""}
              className={inputClass}
            />
          </div>

          {canEdit ? (
            <div className="flex justify-end pt-2">
              <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
                {isPending ? "Saving…" : "Save AI Settings"}
              </button>
            </div>
          ) : null}
        </fieldset>
      </form>
    </section>
  );
}
