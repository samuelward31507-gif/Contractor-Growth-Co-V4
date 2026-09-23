"use server";

import { headers } from "next/headers";
import { isValidEmail } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";
import { resolveAppBaseUrl } from "@/lib/automation/sms";

export type ForgotPasswordState = {
  error?: string;
  success?: boolean;
};

/**
 * Resolves an absolute base URL for Supabase's recovery-email link -
 * identical precedence and identical production-safety guarantee as
 * app/(auth)/signup/actions.ts's resolveSignupBaseUrl() and
 * lib/billing/checkout.ts's resolveCheckoutBaseUrl(): prefer the
 * already-established resolveAppBaseUrl() (deterministically the canonical
 * production URL when VERCEL_ENV === "production", never a per-deployment
 * or localhost value there), only falling back to the incoming request's
 * own Host header when neither applies (local dev). Duplicated here rather
 * than shared, matching this codebase's existing convention of each
 * auth-adjacent action file carrying its own small wrapper around the one
 * shared resolveAppBaseUrl() helper.
 */
async function resolveForgotPasswordBaseUrl(): Promise<string> {
  const configured = resolveAppBaseUrl();
  if (configured) return configured;

  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Never reveals whether the supplied email has an account - the exact same
 * generic message is returned whether resetPasswordForEmail succeeds,
 * fails because the email doesn't exist, or fails for most other reasons.
 * Supabase's own resetPasswordForEmail is already designed not to leak
 * account existence (it does not error for an unknown email), so this
 * mirrors that at the UI layer rather than working around it.
 */
export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const rawEmail = formData.get("email");
  const email = String(rawEmail ?? "").trim();

  if (!email || !isValidEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  const supabase = await createClient();
  const baseUrl = await resolveForgotPasswordBaseUrl();

  // Reuses the exact same production callback URL as signup confirmation -
  // no second callback URL, no separate Supabase Redirect URLs allow-list
  // entry needed. app/auth/confirm/route.ts already branches on
  // type === "recovery" to route here correctly.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${baseUrl}/auth/confirm`,
  });

  // Deliberately not surfaced to the user - the client always renders the
  // same generic "check your email" copy regardless of what happened here
  // (see forgot-password-form.tsx), so account existence is never leaked.
  // Logged server-side only, for operational visibility.
  if (error) {
    console.error("[auth] resetPasswordForEmail failed", { error: error.message });
  }

  return { success: true };
}
