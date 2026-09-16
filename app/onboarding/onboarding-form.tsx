"use client";

import { useActionState } from "react";
import {
  errorBannerClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from "@/lib/ui/form";
import { createOrganization, type OnboardingState } from "./actions";

const initialState: OnboardingState = {};

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(createOrganization, initialState);

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}

      <div className="space-y-1.5">
        <label htmlFor="businessName" className={labelClass}>
          Business name
        </label>
        <input
          id="businessName"
          name="businessName"
          type="text"
          autoComplete="organization"
          required
          maxLength={120}
          className={inputClass}
          placeholder="Acme Roofing & Exteriors"
        />
      </div>

      <button type="submit" disabled={isPending} className={primaryButtonClass}>
        {isPending ? "Setting up…" : "Continue to dashboard"}
      </button>
    </form>
  );
}
