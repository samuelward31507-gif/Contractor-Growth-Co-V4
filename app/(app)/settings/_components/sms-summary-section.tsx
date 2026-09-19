import Link from "next/link";
import { MessageSquare, ChevronRight } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { detailLabelClass, detailValueClass, metaClass, subsectionTitleClass } from "@/lib/ui/typography";

/**
 * A read-only summary + entry point into /settings/sms, shown on the main
 * Settings page so SMS routing is discoverable without knowing the URL.
 * Deliberately not the full edit form (which stays on its own route, since
 * /settings/sms has its own Server Actions and revalidatePath target) - this
 * only reads the same value the SMS page itself reads via
 * getOrganizationSmsNumber, never a second, competing query.
 */
export function SmsSummarySection({ smsPhoneNumber }: { smsPhoneNumber: string | null }) {
  const isConfigured = Boolean(smsPhoneNumber);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={subsectionTitleClass}>SMS &amp; Communications</h2>
          <p className={`mt-1 ${metaClass}`}>The Trackpr number customers text to reach your business.</p>
        </div>
        <Badge tone={isConfigured ? "success" : "neutral"}>{isConfigured ? "Configured" : "Not configured"}</Badge>
      </div>

      <Link
        href="/settings/sms"
        className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3 transition-colors hover:border-slate-300 hover:bg-slate-50"
      >
        <div>
          <p className={detailLabelClass}>Routing number</p>
          <p className={detailValueClass}>
            {smsPhoneNumber ?? "Not set — inbound texts to your business won't reach Trackpr"}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-slate-700">
          <MessageSquare className="h-4 w-4" aria-hidden />
          Manage SMS settings
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Link>
    </section>
  );
}
