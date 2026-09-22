"use server";

import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { mapAuthError } from "@/lib/auth/errors";
import { validatePassword } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export type ResetPasswordState = {
  error?: string;
};

/**
 * Sets a new password for the CALLER's own account, using their own
 * recovery session - never the service-role admin API, and never a
 * client-supplied user id. supabase.auth.updateUser() always operates on
 * whichever user the current session cookie belongs to; there is no
 * parameter anywhere in this action that could redirect it to a different
 * account. If there is no authenticated session at all (e.g. someone
 * navigates here directly, or the recovery link expired before this ran),
 * this rejects outright rather than silently doing nothing.
 */
export async function resetPassword(
  _prevState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const passwordError = validatePassword(password);
  if (passwordError) {
    return { error: passwordError };
  }

  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Your password reset link has expired. Please request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { error: mapAuthError(error) };
  }

  // Same membership-aware redirect login() already uses - the user is now
  // fully authenticated with their new password, so send them straight
  // into the app rather than back to a redundant login form.
  const membership = await getUserOrganization(supabase, user.id);
  redirect(membership ? "/dashboard" : "/onboarding");
}
