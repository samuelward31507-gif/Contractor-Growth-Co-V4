"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  errorBannerClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  successBannerClass,
} from "@/lib/ui/form";
import { signup, type SignupState } from "./actions";

const initialState: SignupState = {};

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signup, initialState);

  if (state.success) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Check your email
        </h1>
        <p className={successBannerClass}>
          We sent a confirmation link to your inbox. Click it to activate your
          account and finish setting up Trackpr.
        </p>
        <Link href="/login" className="inline-block text-sm font-medium text-slate-900 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Create your account
        </h1>
        <p className="text-sm text-slate-500">
          Set up Trackpr for your contracting business.
        </p>
      </div>

      {state.error ? <p className={errorBannerClass}>{state.error}</p> : null}

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className={inputClass}
            placeholder="you@company.com"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className={labelClass}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            className={inputClass}
            placeholder="At least 8 characters"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="confirmPassword" className={labelClass}>
            Confirm password
          </label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            className={inputClass}
            placeholder="Re-enter your password"
          />
        </div>
      </div>

      <button type="submit" disabled={isPending} className={primaryButtonClass}>
        {isPending ? "Creating account…" : "Create account"}
      </button>

      <p className="text-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-slate-900 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
