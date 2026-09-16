import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (membership) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-md space-y-8 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Set up your business
          </h1>
          <p className="text-sm text-slate-500">
            Tell us about your contracting business to finish setting up Trackpr.
          </p>
        </div>
        <OnboardingForm />
      </div>
    </div>
  );
}
