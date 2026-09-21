import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { OnboardingForm } from "./onboarding-form";
import { OnboardingHub } from "./onboarding-hub";
import { PaymentRequired } from "./payment-required";

/**
 * First Client Onboarding V1 + Payment Gate V1: this route now has three
 * states. No organization yet -> the original Step 1 form (extended, see
 * onboarding-form.tsx) - creating an organization is still self-service and
 * unchanged. Organization exists but payment_status isn't 'active' ->
 * PaymentRequired, not the readiness hub - this is the actual enforcement
 * point for "no payment = no usable Trackpr workspace" on this route (the
 * other enforcement point, covering every app/(app)/ route directly, is
 * app/(app)/layout.tsx). Organization exists and is paid -> the persistent,
 * resumable readiness hub (OnboardingHub) covering Steps 2-7, exactly as
 * before. Visiting this page never overwrites anything - it only ever
 * reads and displays the organization's real current configuration.
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

  if (membership.paymentStatus !== "active") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-white px-6 py-16">
        <PaymentRequired organizationName={membership.organizationName ?? "Your business"} />
      </div>
    );
  }

  const canEdit = membership.role === "owner" || membership.role === "admin";

  return <OnboardingHub organizationId={membership.organizationId} canEdit={canEdit} />;
}
