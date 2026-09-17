"use server";

import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";

export type OnboardingState = {
  error?: string;
};

export async function createOrganization(
  _prevState: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const existing = await getUserOrganization(supabase, user.id);
  if (existing) {
    redirect("/dashboard");
  }

  const businessName = String(formData.get("businessName") ?? "").trim();
  if (!businessName) {
    return { error: "Enter your business name." };
  }
  if (businessName.length > 120) {
    return { error: "Business name is too long." };
  }

  const { error: bootstrapError } = await supabase.rpc("bootstrap_organization", {
    org_name: businessName,
  });

  if (bootstrapError) {
    return { error: "We couldn't create your organization. Please try again." };
  }

  redirect("/dashboard");
}
