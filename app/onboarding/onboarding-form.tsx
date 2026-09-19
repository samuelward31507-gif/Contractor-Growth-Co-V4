"use client";

import { useActionState } from "react";
import { authButtonClass, authErrorBannerClass, authInputClass, authLabelClass } from "@/lib/ui/auth-form";
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

      <button type="submit" disabled={isPending} className={authButtonClass}>
        {isPending ? "Setting up…" : "Continue to dashboard"}
      </button>
    </form>
  );
}
