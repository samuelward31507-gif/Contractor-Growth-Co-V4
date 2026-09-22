"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  authButtonClass,
  authErrorBannerClass,
  authInputClass,
  authLabelClass,
  authSuccessBannerClass,
} from "@/lib/ui/auth-form";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

const initialState: ForgotPasswordState = {};

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(requestPasswordReset, initialState);

  if (state.success) {
    return (
      <div className="space-y-5 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Check your email</h1>
        <p className={`${authSuccessBannerClass} text-left`}>
          <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
              clipRule="evenodd"
            />
          </svg>
          <span>If an account exists for that email, you&apos;ll receive instructions to reset your password.</span>
        </p>
        <Link href="/login" className="inline-block text-[13px] font-medium text-slate-900 underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-7" noValidate>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Reset your password.</h1>
        <p className="text-sm text-slate-500">Enter your email and we&apos;ll send you a link to reset it.</p>
      </div>

      {state.error ? (
        <p className={authErrorBannerClass} role="alert">
          <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0">
            <path
              fillRule="evenodd"
              d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.63-1.516 2.63H3.72c-1.347 0-2.189-1.463-1.515-2.63L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              clipRule="evenodd"
            />
          </svg>
          <span>{state.error}</span>
        </p>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="email" className={authLabelClass}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={authInputClass}
          placeholder="you@company.com"
        />
      </div>

      <button type="submit" disabled={isPending} className={authButtonClass}>
        {isPending ? (
          <>
            <svg aria-hidden className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
            </svg>
            <span className="ml-2">Sending…</span>
          </>
        ) : (
          "Send reset link"
        )}
      </button>

      <p className="text-center text-[13px] text-slate-500">
        Remembered your password?{" "}
        <Link href="/login" className="font-medium text-slate-900 underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
