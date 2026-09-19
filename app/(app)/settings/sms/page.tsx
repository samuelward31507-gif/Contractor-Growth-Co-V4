import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getOrganizationSmsNumber } from "@/lib/settings/sms-routing";
import { SmsRoutingSection } from "./_components/sms-routing-section";

/**
 * Standalone route, not yet linked from the main settings page/nav - see
 * this feature's own audit: every file under app/(app)/settings/ is
 * currently part of the in-progress, uncommitted Trackpr 2.0 redesign, and
 * this feature must not touch any of it. Reachable directly at
 * /settings/sms; wiring it into the real settings page/navigation is
 * follow-up work for whoever completes the 2.0 redesign.
 */
export default async function SmsRoutingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const canEdit = membership.role === "owner" || membership.role === "admin";
  const smsPhoneNumber = await getOrganizationSmsNumber(supabase, membership.organizationId);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">SMS &amp; Communications Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Configure the Trackpr SMS number your customers text when replying to your business.
        </p>
      </div>

      <SmsRoutingSection smsPhoneNumber={smsPhoneNumber} canEdit={canEdit} />
    </div>
  );
}
