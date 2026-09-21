"use server";

import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { mapAuthError } from "@/lib/auth/errors";
import { isValidEmail, validatePassword } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";
import { sendSignupNotification } from "@/lib/email/send-signup-notification";

export type SignupState = {
  error?: string;
  success?: boolean;
};

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

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

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
