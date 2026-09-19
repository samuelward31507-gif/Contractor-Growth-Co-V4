"use client";

import { useActionState } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import { getTimezoneOptions } from "@/lib/settings/format";
import type { BusinessProfile } from "@/lib/settings/queries";
import { updateBusinessProfile, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

export function BusinessProfileSection({
  profile,
  canEdit,
}: {
  profile: BusinessProfile;
  canEdit: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateBusinessProfile, initialState);
  const timezones = getTimezoneOptions();

  return (
    <section>
      <h2 className={subsectionTitleClass}>Business profile</h2>
      <p className={`mt-1 ${metaClass}`}>Business identity, contact information, location, and timezone.</p>

      <form action={formAction} className="mt-5">
        <fieldset disabled={!canEdit || isPending} className="space-y-4">
          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}
          {state.success ? <p className={successBannerClass}>Business profile saved.</p> : null}

          <div className="space-y-1.5">
            <label htmlFor="name" className={labelClass}>
              Business name
            </label>
            <input id="name" name="name" defaultValue={profile.name} required className={inputClass} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="phone" className={labelClass}>
                Business phone
              </label>
              <input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={profile.phone ?? ""}
                className={inputClass}
                placeholder="(555) 123-4567"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="email" className={labelClass}>
                Business email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={profile.email ?? ""}
                className={inputClass}
                placeholder="hello@company.com"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="address" className={labelClass}>
              Address
            </label>
            <input id="address" name="address" defaultValue={profile.address ?? ""} className={inputClass} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <label htmlFor="city" className={labelClass}>
                City
              </label>
              <input id="city" name="city" defaultValue={profile.city ?? ""} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="state" className={labelClass}>
                State
              </label>
              <input id="state" name="state" defaultValue={profile.state ?? ""} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="zip" className={labelClass}>
                ZIP
              </label>
              <input id="zip" name="zip" defaultValue={profile.zip ?? ""} className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="website" className={labelClass}>
                Website
              </label>
              <input
                id="website"
                name="website"
                defaultValue={profile.website ?? ""}
                className={inputClass}
                placeholder="https://example.com"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="timezone" className={labelClass}>
                Timezone
              </label>
              <select id="timezone" name="timezone" defaultValue={profile.timezone} className={inputClass}>
                {timezones.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <p className={metaClass}>Used for business hours and appointment times.</p>
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
