"use client";

import Link from "next/link";
import { useActionState } from "react";
import { authButtonClass, authErrorBannerClass } from "@/lib/ui/auth-form";
import { startCheckout, type StartCheckoutState } from "./actions";

const initialState: StartCheckoutState = {};

/**
 * Payment Gate V1: shown instead of the readiness hub whenever an
 * organization exists but its payment_status isn't 'active' yet - see
 * app/onboarding/page.tsx. Deliberately minimal (no pricing calculator, no
 * plan picker, no embedded checkout UI) - the actual charge amounts live in
 * Stripe (STRIPE_SETUP_PRICE_ID / STRIPE_SUBSCRIPTION_PRICE_ID), this is
 * just the one button that starts a real, server-created Checkout Session.
 */
export function PaymentRequired({ organizationName }: { organizationName: string }) {
  const [state, formAction, isPending] = useActionState(startCheckout, initialState);

  return (
    <div className="w-full max-w-sm">
      <span className="text-[15px] font-semibold tracking-tight text-slate-900">Trackpr</span>
      <div className="mt-8 space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Complete your setup.</h1>
        <p className="text-sm text-slate-500">
          {organizationName} is created, but not active yet. Complete payment to unlock your Trackpr workspace.
        </p>
      </div>

      <div className="mt-8 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3.5">
        <p className="text-sm font-medium text-slate-900">$2,500 implementation/setup</p>
        <p className="text-sm text-slate-600">+ $1,497/month management</p>
      </div>

      <form action={formAction} className="mt-6 space-y-4">
        {state.error ? <p className={authErrorBannerClass}>{state.error}</p> : null}
        <button type="submit" disabled={isPending} className={authButtonClass}>
          {isPending ? "Redirecting to checkout…" : "Complete payment"}
        </button>
      </form>

      <p className="mt-4 text-center text-[12px] leading-relaxed text-slate-400">
        By continuing, you agree to the Contractor Growth Co.{" "}
        <Link href="/terms" target="_blank" className="underline-offset-4 hover:underline">
          Terms of Service
        </Link>{" "}
        and acknowledge the{" "}
        <Link href="/privacy" target="_blank" className="underline-offset-4 hover:underline">
          Privacy Policy
        </Link>
        .
      </p>

      <p className="mt-6 text-center text-[13px] text-slate-500">
        Already paid? If this doesn&apos;t update shortly, contact Contractor Growth Co.
      </p>
    </div>
  );
}
