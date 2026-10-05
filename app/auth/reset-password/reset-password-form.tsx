"use client";

import { useActionState } from "react";
import { AuthError, AuthHeader, AuthSubmit, authLabelClass } from "@/app/(auth)/_components/auth-ui";
import { PasswordInput } from "@/app/(auth)/_components/password-input";
import { resetPassword, type ResetPasswordState } from "./actions";

const initialState: ResetPasswordState = {};
const ERROR_ID = "reset-password-error";

export function ResetPasswordForm() {
  const [state, formAction, isPending] = useActionState(resetPassword, initialState);
  const describedBy = state.error ? ERROR_ID : undefined;

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <AuthHeader title="Set your password." subtitle="Choose a password for your account." />

      {state.error ? <AuthError id={ERROR_ID}>{state.error}</AuthError> : null}

      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="password" className={authLabelClass}>
            New password
          </label>
          <PasswordInput id="password" name="password" autoComplete="new-password" minLength={8} placeholder="At least 8 characters" describedBy={describedBy} />
        </div>

        <div className="space-y-2">
          <label htmlFor="confirmPassword" className={authLabelClass}>
            Confirm new password
          </label>
          <PasswordInput id="confirmPassword" name="confirmPassword" autoComplete="new-password" minLength={8} placeholder="Re-enter your new password" describedBy={describedBy} />
        </div>
      </div>

      <AuthSubmit pending={isPending} idleLabel="Update password" pendingLabel="Updating…" />
    </form>
  );
}
