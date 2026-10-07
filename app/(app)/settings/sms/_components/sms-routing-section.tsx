"use client";

import { useActionState, useState } from "react";
import { MessageSquare, Info, AlertTriangle } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { detailLabelClass, detailValueClass, metaClass } from "@/lib/ui/typography";
import { updateSmsPhoneNumber, clearSmsPhoneNumber, type SmsRoutingActionState } from "../actions";

const initialState: SmsRoutingActionState = {};

export function SmsRoutingSection({
  smsPhoneNumber,
  canEdit,
}: {
  smsPhoneNumber: string | null;
  canEdit: boolean;
}) {
  const [saveState, saveAction, isSaving] = useActionState(updateSmsPhoneNumber, initialState);
  const [clearState, clearAction, isClearing] = useActionState(clearSmsPhoneNumber, initialState);
  const [pendingValue, setPendingValue] = useState(smsPhoneNumber ?? "");

  const isPending = isSaving || isClearing;
  const isConfigured = Boolean(smsPhoneNumber);

  return (
    <SectionCard
      title="SMS routing number"
      description="The Trackpr phone number your customers text to reach your business."
      icon={MessageSquare}
      action={<Badge tone={isConfigured ? "success" : "neutral"}>{isConfigured ? "Configured" : "Not Configured"}</Badge>}
    >
      <div className="space-y-5">
        <div className="rounded-lg border border-line bg-canvas/60 px-3.5 py-2.5">
          <p className={detailLabelClass}>Current configuration</p>
          <p className={detailValueClass}>{smsPhoneNumber ?? "Not set"}</p>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-info-border bg-info-muted px-3.5 py-2.5 text-xs text-info-text">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <p>
            Inbound texts sent to this number are routed into your Trackpr conversation inbox, where they can trigger AI qualification and automated
            follow-up.
          </p>
        </div>

        {!isConfigured ? (
          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-muted px-3.5 py-2.5 text-xs text-warning-text">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <p>
              Until a number is set, texts your customers send to your business won&apos;t reach Trackpr — they won&apos;t appear in your inbox and
              won&apos;t trigger any AI or automation follow-up.
            </p>
          </div>
        ) : null}

        {!canEdit ? (
          <p className="rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink-2">
            You have read-only access. Only owners and admins can change this setting.
          </p>
        ) : null}

        <form action={saveAction} className="space-y-4">
          <fieldset disabled={!canEdit || isPending} className="space-y-4">
            {saveState.error ? <p className={errorBannerClass} role="alert">{saveState.error}</p> : null}
            {saveState.success ? <p className={successBannerClass}>SMS number saved.</p> : null}
            {saveState.auditWarning ? <p className={errorBannerClass} role="alert">{saveState.auditWarning}</p> : null}

            <div className="space-y-1.5">
              <label htmlFor="smsPhoneNumber" className={labelClass}>
                Trackpr SMS number
              </label>
              <input
                id="smsPhoneNumber"
                name="smsPhoneNumber"
                type="tel"
                inputMode="tel"
                value={pendingValue}
                onChange={(event) => setPendingValue(event.target.value)}
                placeholder="+15551234567"
                aria-describedby="smsPhoneNumber-hint"
                className={inputClass}
              />
              <p id="smsPhoneNumber-hint" className={metaClass}>
                E.164 format, example: +15551234567. This must be the number configured to send inbound texts to Trackpr, and each number can only be
                assigned to one business.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button type="submit" disabled={!canEdit || isPending} className={primaryButtonAutoClass}>
                {isSaving ? "Saving…" : "Save"}
              </button>
              {isConfigured ? (
                <button
                  type="submit"
                  formAction={clearAction}
                  disabled={!canEdit || isPending}
                  className={secondaryButtonAutoClass}
                  onClick={() => setPendingValue("")}
                >
                  {isClearing ? "Clearing…" : "Clear number"}
                </button>
              ) : null}
            </div>
          </fieldset>
        </form>

        {clearState.error ? <p className={errorBannerClass} role="alert">{clearState.error}</p> : null}
        {clearState.success ? <p className={successBannerClass}>SMS number cleared.</p> : null}
        {clearState.auditWarning ? <p className={errorBannerClass} role="alert">{clearState.auditWarning}</p> : null}
      </div>
    </SectionCard>
  );
}
