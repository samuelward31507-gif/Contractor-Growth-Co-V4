"use server";

import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { mapAuthError } from "@/lib/auth/errors";
import { isValidEmail } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export type LoginState = {
  error?: string;
};

export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !isValidEmail(email)) {
    return { error: "Enter a valid email address." };
  }
  if (!password) {
    return { error: "Enter your password." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    return { error: error ? mapAuthError(error) : "We couldn't sign you in. Please try again." };
  }

  const membership = await getUserOrganization(supabase, data.user.id);
  redirect(membership ? "/dashboard" : "/onboarding");
}
