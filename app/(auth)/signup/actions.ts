"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { mapAuthError } from "@/lib/auth/errors";
import { isValidEmail, validatePassword } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";
import { sendSignupNotification } from "@/lib/email/send-signup-notification";
import { resolveAppBaseUrl } from "@/lib/automation/sms";
import { TERMS_VERSION } from "@/lib/legal/terms-version";

export type SignupState = {
  error?: string;
  success?: boolean;
};

/**
 * Resolves an absolute base URL for Supabase's confirmation-email link,
 * same precedence as lib/billing/checkout.ts's resolveCheckoutBaseUrl:
 * prefer the already-established resolveAppBaseUrl() (APP_BASE_URL, falling
 * back to Vercel's own production-URL env var), only falling back to the
 * incoming request's own Host header when neither is set (local dev).
 */
async function resolveSignupBaseUrl(): Promise<string> {
  const configured = resolveAppBaseUrl();
  if (configured) return configured;

  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function signup(
  _prevState: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!email || !isValidEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return { error: passwordError };
  }

  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  // Never trust the checkbox's client-side "checked" state alone - the only
  // thing that matters is what actually arrived in the submitted form data.
  // A truthy-but-"false" string (e.g. a hidden field default) must not pass;
  // an unchecked HTML checkbox omits the field entirely, so this also
  // covers that case. Rejected here, before signUp() is ever called, so no
  // auth user (let alone an organization) is created without consent.
  const agreeToTerms = formData.get("agreeToTerms") === "true";
  if (!agreeToTerms) {
    return { error: "You must agree to the Terms of Service and acknowledge the Privacy Policy to create an account." };
  }

  const supabase = await createClient();
  const baseUrl = await resolveSignupBaseUrl();
  const termsAcceptedAt = new Date().toISOString();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${baseUrl}/auth/confirm`,
      // Stamped into the auth user's own metadata, not a client-supplied
      // value - termsAcceptedAt/TERMS_VERSION are both computed server-side,
      // above. No organization exists yet at this point (see
      // app/onboarding/actions.ts's createOrganization for why), so this is
      // the one place consent can be durably recorded against the account
      // itself, then copied onto the organization row once one exists.
      data: { terms_accepted_at: termsAcceptedAt, terms_version: TERMS_VERSION },
    },
  });

  if (error) {
    return { error: mapAuthError(error) };
  }

  // Supabase returns a user with an empty `identities` array (and no error)
  // when the email is already registered and email confirmation is required -
  // this avoids leaking account existence, so we surface a soft duplicate hint.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return {
      error:
        "An account with this email may already exist. Try signing in, or check your inbox for a confirmation link.",
    };
  }

  // A genuinely new account was just created by Supabase (the duplicate-email
  // signal above has already been ruled out) - notify Contractor Growth Co.
  // internally, exactly once, from this single server-side path. This never
  // touches or replaces the customer's own Supabase confirmation email, and
  // a failure here can never fail the signup itself - see
  // sendSignupNotification's own error handling.
  if (data.user) {
    await sendSignupNotification({ email, userId: data.user.id });
  }

  if (!data.session) {
    return { success: true };
  }

  const membership = data.user ? await getUserOrganization(supabase, data.user.id) : null;
  redirect(membership ? "/dashboard" : "/onboarding");
}
