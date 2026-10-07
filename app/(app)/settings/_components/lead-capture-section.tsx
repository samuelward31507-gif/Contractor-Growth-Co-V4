import { Inbox } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { detailLabelClass, detailValueClass, metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import { DEFAULT_SMS_CONSENT_DISCLOSURE } from "@/lib/leads/sms-consent";
import { RotateIntakeTokenForm } from "./rotate-intake-token-form";

/**
 * First-Client Lead Capture V1: the read-only display of the URL a
 * contractor's own lead source (website contact form, lead-gen platform
 * webhook, Zapier/Make, etc.) should POST to. Mirrors SmsSummarySection's
 * exact shape (read-only info block, Badge, no new UI pattern) - this
 * feature has no configuration to change here, only a value to copy. Final
 * Batch 2 added the owner/admin-only "Rotate intake URL" control
 * (canRotate) and documents the optional SMS consent fields.
 */
export function LeadCaptureSection({ intakeUrl, canRotate = false }: { intakeUrl: string | null; canRotate?: boolean }) {
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

      <div className="mt-4 rounded-lg border border-line bg-canvas/60 px-4 py-3">
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
        <p className={`mt-2 ${metaClass}`}>
          SMS consent: send <code>sms_consent</code> (<code>true</code> only if the person ticked a texting checkbox) and{" "}
          <code>sms_consent_text</code> (the exact wording your form showed). Every lead is captured, but Trackpr texts a
          new lead automatically only when <code>sms_consent</code> is <code>true</code> — without it, the lead waits for
          you on Today. Example wording to adapt: “{DEFAULT_SMS_CONSENT_DISCLOSURE}”
        </p>
        {intakeUrl && canRotate ? <RotateIntakeTokenForm /> : null}
      </div>
    </section>
  );
}
