import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { ArrowLeft } from "lucide-react";
import { getOrganizationSmsNumber } from "@/lib/settings/sms-routing";
import { pageTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { SmsRoutingSection } from "./_components/sms-routing-section";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

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
  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const canEdit = membership.role === "owner" || membership.role === "admin";
  const smsPhoneNumber = await getOrganizationSmsNumber(supabase, membership.organizationId);

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div>
        <Link href="/settings" className="-my-3 inline-flex min-h-11 items-center gap-1 rounded text-xs font-medium text-ink-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:my-0 sm:min-h-0">
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
