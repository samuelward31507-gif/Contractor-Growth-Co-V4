"use client";

import { useActionState } from "react";
import { authButtonClass, authErrorBannerClass, authInputClass, authLabelClass } from "@/lib/ui/auth-form";
import { TRADE_OPTIONS } from "@/lib/settings/queries";
import { createOrganization, type OnboardingState } from "./actions";

const initialState: OnboardingState = {};

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(createOrganization, initialState);

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? <p className={authErrorBannerClass}>{state.error}</p> : null}

      <div className="space-y-1.5">
        <label htmlFor="businessName" className={authLabelClass}>
          Business name
        </label>
        <input
          id="businessName"
          name="businessName"
          type="text"
          autoComplete="organization"
          required
          maxLength={120}
          className={authInputClass}
          placeholder="Acme Roofing & Exteriors"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="ownerName" className={authLabelClass}>
          Owner / contact name
        </label>
        <input id="ownerName" name="ownerName" type="text" maxLength={120} className={authInputClass} placeholder="Jamie Rivera" />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="phone" className={authLabelClass}>
          Business phone
        </label>
        <input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={40} className={authInputClass} placeholder="(555) 123-4567" />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="trade" className={authLabelClass}>
          Trade
        </label>
        <select id="trade" name="trade" defaultValue="" className={authInputClass}>
          <option value="">Select a trade</option>
          {TRADE_OPTIONS.map((trade) => (
            <option key={trade} value={trade}>
              {trade}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="serviceArea" className={authLabelClass}>
          Service area
        </label>
        <input id="serviceArea" name="serviceArea" type="text" maxLength={120} className={authInputClass} placeholder="Denver metro" />
      </div>

      <button type="submit" disabled={isPending} className={authButtonClass}>
        {isPending ? "Setting up…" : "Continue"}
      </button>
    </form>
  );
}
