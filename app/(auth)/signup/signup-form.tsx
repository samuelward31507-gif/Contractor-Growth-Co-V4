"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AuthError, AuthHeader, AuthNotice, AuthSubmit, authCheckboxClass, authFieldClass, authLabelClass, authLinkClass } from "../_components/auth-ui";
import { PasswordInput } from "../_components/password-input";
import { signup, type SignupState } from "./actions";

const initialState: SignupState = {};
const ERROR_ID = "signup-error";

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signup, initialState);
  const describedBy = state.error ? ERROR_ID : undefined;

  if (state.success) {
    return (
      <div className="space-y-8">
        <AuthHeader title="Check your email" />
        <AuthNotice>We sent a confirmation link to your inbox. Click it to activate your account and finish setting up Trackpr.</AuthNotice>
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
      <AuthHeader title="Create your account." subtitle="Set up Trackpr for your business." />

      {state.error ? <AuthError id={ERROR_ID}>{state.error}</AuthError> : null}

      <div className="space-y-5">
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
            aria-describedby={describedBy}
            className={authFieldClass}
            placeholder="you@company.com"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="password" className={authLabelClass}>
            Password
          </label>
          <PasswordInput id="password" name="password" autoComplete="new-password" minLength={8} placeholder="At least 8 characters" describedBy={describedBy} />
        </div>

        <div className="space-y-2">
          <label htmlFor="confirmPassword" className={authLabelClass}>
            Confirm password
          </label>
          <PasswordInput id="confirmPassword" name="confirmPassword" autoComplete="new-password" minLength={8} placeholder="Re-enter your password" describedBy={describedBy} />
        </div>

        <div className="flex items-start gap-3 pt-1">
          <input id="agreeToTerms" name="agreeToTerms" type="checkbox" value="true" required aria-required="true" className={authCheckboxClass} />
          <label htmlFor="agreeToTerms" className="text-[13px] leading-relaxed text-cinder-ink-2">
            I agree to the{" "}
            <Link href="/terms" target="_blank" className={authLinkClass}>
              Terms of Service
            </Link>{" "}
            and acknowledge the{" "}
            <Link href="/privacy" target="_blank" className={authLinkClass}>
              Privacy Policy
            </Link>
            .
          </label>
        </div>
      </div>

      <AuthSubmit pending={isPending} idleLabel="Create account" pendingLabel="Creating account…" />

      <p className="border-t border-cinder-line pt-6 text-center text-[13px] text-cinder-ink-3">
        Already have an account?{" "}
        <Link href="/login" className={authLinkClass}>
          Sign in
        </Link>
      </p>
    </form>
  );
}
