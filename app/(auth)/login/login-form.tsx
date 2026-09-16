"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  errorBannerClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from "@/lib/ui/form";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Welcome back
        </h1>
        <p className="text-sm text-slate-500">
          Sign in to your Trackpr control center.
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
            autoComplete="current-password"
            required
            className={inputClass}
            placeholder="••••••••"
          />
        </div>
      </div>

      <button type="submit" disabled={isPending} className={primaryButtonClass}>
        {isPending ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-center text-sm text-slate-500">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-slate-900 hover:underline">
          Create one
        </Link>
      </p>
    </form>
  );
}
