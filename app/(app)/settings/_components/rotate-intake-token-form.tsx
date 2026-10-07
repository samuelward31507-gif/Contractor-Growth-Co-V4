"use client";

import { useActionState } from "react";
import { errorBannerClass, secondaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { rotateLeadIntakeToken, type LeadIntakeTokenActionState } from "../lead-capture/actions";

const initialState: LeadIntakeTokenActionState = {};

/** Final Batch 2: owner/admin-only rotation of the intake URL's token. Only rendered for owners/admins; the action and RLS enforce it again. */
export function RotateIntakeTokenForm() {
  const [state, action, isPending] = useActionState(rotateLeadIntakeToken, initialState);
  return (
    <form
      action={action}
      className="mt-3"
      onSubmit={(event) => {
        if (!window.confirm("Rotate the intake URL? The current URL stops working immediately - update every form or lead source to the new URL.")) event.preventDefault();
      }}
    >
      <button type="submit" disabled={isPending} className={secondaryButtonAutoClass}>
        {isPending ? "Rotating…" : "Rotate intake URL"}
      </button>
      {state.error ? <p className={`mt-2 ${errorBannerClass}`} role="alert">{state.error}</p> : null}
      {state.success ? <p className={`mt-2 ${successBannerClass}`}>Intake URL rotated. Update your forms with the new URL above.{state.auditWarning ? ` ${state.auditWarning}` : ""}</p> : null}
    </form>
  );
}
