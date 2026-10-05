"use client";

import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import { AuthError, AuthHeader, AuthSubmit, authFieldClass, authLabelClass, authLinkClass } from "../_components/auth-ui";
import { PasswordInput } from "../_components/password-input";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};
const ERROR_ID = "login-error";

/** `notice` is a page-level message (an expired confirmation link) shown under the heading. */
export function LoginForm({ notice }: { notice?: ReactNode }) {
  const [state, formAction, isPending] = useActionState(login, initialState);
  const describedBy = state.error ? ERROR_ID : undefined;

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <AuthHeader title="Welcome back." subtitle="Sign in to your revenue operating system." />

      {notice}
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
          <div className="flex items-baseline justify-between gap-4">
            <label htmlFor="password" className={authLabelClass}>
              Password
            </label>
            <Link href="/forgot-password" className={`text-[13px] text-cinder-ink-2 ${authLinkClass}`}>
              Forgot password?
            </Link>
          </div>
          <PasswordInput id="password" name="password" autoComplete="current-password" describedBy={describedBy} />
        </div>
      </div>

      <AuthSubmit pending={isPending} idleLabel="Sign in" pendingLabel="Signing in…" />

      <p className="border-t border-cinder-line pt-6 text-center text-[13px] text-cinder-ink-3">
        New to Trackpr?{" "}
        <Link href="/signup" className={authLinkClass}>
          Create an account
        </Link>
      </p>
    </form>
  );
}
