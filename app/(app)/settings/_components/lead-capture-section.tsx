import { Inbox } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { detailLabelClass, detailValueClass, metaClass, subsectionTitleClass } from "@/lib/ui/typography";

/**
 * First-Client Lead Capture V1: the read-only display of the URL a
 * contractor's own lead source (website contact form, lead-gen platform
 * webhook, Zapier/Make, etc.) should POST to. Mirrors SmsSummarySection's
 * exact shape (read-only info block, Badge, no new UI pattern) - this
 * feature has no configuration to change here, only a value to copy, so
 * there is no form/action needed.
 */
export function LeadCaptureSection({ intakeUrl }: { intakeUrl: string | null }) {
  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={subsectionTitleClass}>Lead Capture</h2>
          <p className={`mt-1 ${metaClass}`}>
            Send new leads from your website form or lead source to this URL to have Trackpr capture and follow up automatically.
          </p>
        </div>
        <Badge tone={intakeUrl ? "success" : "neutral"}>{intakeUrl ? "Ready" : "Unavailable"}</Badge>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3">
        <p className={detailLabelClass}>Intake URL (POST, JSON body)</p>
        {intakeUrl ? (
          <code className={`mt-1 block break-all text-xs ${detailValueClass}`}>{intakeUrl}</code>
        ) : (
          <p className={`mt-1 ${detailValueClass}`}>
            Not available in this environment yet — configure APP_BASE_URL or deploy to production.
          </p>
        )}
        <p className={`mt-2 ${metaClass}`}>
          Accepts <code>name</code> (or <code>first_name</code>/<code>last_name</code>), <code>phone</code>,{" "}
          <code>email</code>, <code>service</code>, <code>source</code>, and <code>message</code>. At least one of phone or
          email is required.
        </p>
        <p className={`mt-1 ${metaClass}`}>
          <Inbox className="mr-1 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
          Keep this URL private — anyone with it can create leads in your account.
        </p>
      </div>
    </section>
  );
}
