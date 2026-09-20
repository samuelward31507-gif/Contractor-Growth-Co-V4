"use client";

import { useActionState } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import type { BusinessProfile } from "@/lib/settings/queries";
import { updateReputationSettings, type SettingsActionState } from "../actions";

const initialState: SettingsActionState = {};

export function ReputationSection({
  profile,
  canEdit,
}: {
  profile: Pick<BusinessProfile, "review_url" | "facebook_url">;
  canEdit: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateReputationSettings, initialState);

  return (
    <section>
      <h2 className={subsectionTitleClass}>Reputation</h2>
      <p className={`mt-1 ${metaClass}`}>Links used for review and referral requests after a completed job.</p>

      <form action={formAction} className="mt-5">
        <fieldset disabled={!canEdit || isPending} className="space-y-4">
          {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}
          {state.success ? <p className={successBannerClass}>Reputation links saved.</p> : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="reviewUrl" className={labelClass}>
                Google review URL
              </label>
              <input
                id="reviewUrl"
                name="reviewUrl"
                type="url"
                defaultValue={profile.review_url ?? ""}
                className={inputClass}
                placeholder="https://g.page/r/..."
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="facebookUrl" className={labelClass}>
                Facebook page URL
              </label>
              <input
                id="facebookUrl"
                name="facebookUrl"
                type="url"
                defaultValue={profile.facebook_url ?? ""}
                className={inputClass}
                placeholder="https://facebook.com/..."
              />
            </div>
          </div>
          <p className={metaClass}>Optional. When set, the post-job follow-up message can ask happy customers to leave a review.</p>

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
