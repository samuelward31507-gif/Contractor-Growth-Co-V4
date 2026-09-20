import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { OnboardingForm } from "./onboarding-form";
import { OnboardingHub } from "./onboarding-hub";

/**
 * First Client Onboarding V1: this route now has two states instead of
 * one-and-done. No organization yet -> the original Step 1 form (extended,
 * see onboarding-form.tsx). Organization already exists -> a persistent,
 * resumable readiness hub (OnboardingHub) covering Steps 2-7, rather than
 * redirecting straight to /dashboard the way this page previously did.
 * Visiting this page never overwrites anything - it only ever reads and
 * displays the organization's real current configuration.
 */
export default async function OnboardingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);

  if (!membership) {
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

  const canEdit = membership.role === "owner" || membership.role === "admin";

  return <OnboardingHub organizationId={membership.organizationId} canEdit={canEdit} />;
}
