"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AuthError, AuthHeader, AuthNotice, AuthSubmit, authFieldClass, authLabelClass, authLinkClass } from "../_components/auth-ui";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

const initialState: ForgotPasswordState = {};
const ERROR_ID = "forgot-password-error";

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(requestPasswordReset, initialState);

  if (state.success) {
    return (
      <div className="space-y-8">
        <AuthHeader title="Check your email" />
        <AuthNotice>If an account exists for that email, you&apos;ll receive instructions to reset your password.</AuthNotice>
        <p className="text-[13px]">
          <Link href="/login" className={authLinkClass}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <AuthHeader title="Reset your password." subtitle="Enter your email and we'll send you a link to reset it." />

      {state.error ? <AuthError id={ERROR_ID}>{state.error}</AuthError> : null}

      <div className="space-y-2">
        <label htmlFor="email" className={authLabelClass}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-describedby={state.error ? ERROR_ID : undefined}
          className={authFieldClass}
          placeholder="you@company.com"
        />
      </div>

      <AuthSubmit pending={isPending} idleLabel="Send reset link" pendingLabel="Sending…" />

      <p className="border-t border-cinder-line pt-6 text-center text-[13px] text-cinder-ink-3">
        Remembered your password?{" "}
        <Link href="/login" className={authLinkClass}>
          Sign in
        </Link>
      </p>
    </form>
  );
}
