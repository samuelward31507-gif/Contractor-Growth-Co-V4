import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getOrganizationSmsNumber } from "@/lib/settings/sms-routing";
import { pageTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { SmsRoutingSection } from "./_components/sms-routing-section";

/**
 * Now reachable from the main Settings page via the "Communications" group
 * (see ../_components/sms-summary-section.tsx), not just by typed URL. Kept
 * as its own route rather than merged into app/(app)/settings/page.tsx -
 * this feature has its own Server Actions (./actions.ts) and its own
 * revalidatePath("/settings/sms") target, so folding it into the main
 * settings page.tsx would mean either duplicating that action wiring or
 * changing its revalidation target, neither of which this redesign touches.
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
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <Link href="/settings" className="inline-flex items-center gap-1 rounded text-xs font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Settings
        </Link>
        <div className="mt-3">
          <h1 className={pageTitleClass}>SMS &amp; Communications</h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>
            Configure the Trackpr SMS number your customers text when replying to your business.
          </p>
        </div>
      </div>

      <SmsRoutingSection smsPhoneNumber={smsPhoneNumber} canEdit={canEdit} />
    </div>
  );
}
