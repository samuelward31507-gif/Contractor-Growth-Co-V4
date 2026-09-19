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
    <div className="flex flex-1 flex-col items-center justify-center bg-white px-6 py-16">
      <div className="w-full max-w-sm">
        <span className="text-[15px] font-semibold tracking-tight text-slate-900">Trackpr</span>
        <div className="mt-8 space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Welcome to Trackpr.</h1>
          <p className="text-sm text-slate-500">Let&apos;s set up your business to finish getting started.</p>
        </div>
        <div className="mt-8">
          <OnboardingForm />
        </div>
      </div>
    </div>
  );
}
