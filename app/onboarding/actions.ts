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

  const { data: organization, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: businessName })
    .select("id")
    .single();

  if (orgError || !organization) {
    return { error: "We couldn't create your organization. Please try again." };
  }

  const { error: membershipError } = await supabase.from("organization_members").insert({
    organization_id: organization.id,
    user_id: user.id,
    role: "owner",
  });

  if (membershipError) {
    // Best-effort cleanup so a failed membership insert doesn't leave an
    // orphaned organization with no owner.
    await supabase.from("organizations").delete().eq("id", organization.id);
    return { error: "We couldn't finish setting up your organization. Please try again." };
  }

  redirect("/dashboard");
}
