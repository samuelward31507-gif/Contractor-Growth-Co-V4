"use client";

import { useState, useTransition } from "react";
import { Settings } from "lucide-react";
import { updateCustomerReactivationConfig } from "../actions";
import { CUSTOMER_REACTIVATION_INACTIVITY_DAYS_MIN, CUSTOMER_REACTIVATION_INACTIVITY_DAYS_MAX, DEFAULT_CUSTOMER_REACTIVATION_CONFIG } from "@/lib/automation/settings";
import { BusinessHoursToggleField } from "./business-hours-toggle-field";
import { SectionCard } from "@/lib/ui/section-card";
import { primaryButtonAutoClass } from "@/lib/ui/form";

const DEFAULT_DAYS = DEFAULT_CUSTOMER_REACTIVATION_CONFIG.inactivity_days;
const DEFAULT_RESPECT_HOURS = DEFAULT_CUSTOMER_REACTIVATION_CONFIG.respect_business_hours;

/**
 * Growth System Completion Pass 2, Part 7/13 - only ever rendered for org
 * admins (the page checks membership.role before rendering this at all,
 * same gate as every other *ConfigForm). Mirrors
 * InboundCustomerReplyConfigForm's exact shape (a numeric field plus a
 * business-hours toggle, saved together as one config object).
 *
 * inactivity_days only changes how long since a customer's last completed
 * job must pass before they become eligible for a single reactivation
 * touch. respect_business_hours only changes whether the outbound gate
 * additionally requires business hours to be open before allowing this
 * automation's send. Neither has any effect on the "no active opportunity"/
 * "no open conversation" eligibility checks, opt-out handling,
 * duplicate-send protection, or any message already sent.
 */
export function CustomerReactivationConfigForm({
  initialInactivityDays,
  initialRespectBusinessHours,
  hasBusinessHoursConfigured,
}: {
  initialInactivityDays: number;
  initialRespectBusinessHours: boolean;
  hasBusinessHoursConfigured: boolean;
}) {
  const [savedDays, setSavedDays] = useState(initialInactivityDays);
  const [savedRespectHours, setSavedRespectHours] = useState(initialRespectBusinessHours);
  const [inputValue, setInputValue] = useState(String(initialInactivityDays));
  const [respectHours, setRespectHours] = useState(initialRespectBusinessHours);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isDirty = inputValue !== String(savedDays) || respectHours !== savedRespectHours;
  const isAtDefault = savedDays === DEFAULT_DAYS && savedRespectHours === DEFAULT_RESPECT_HOURS;

  function commit(parsedDays: number, respectBusinessHours: boolean) {
    setError(null);
    setSuccess(false);

    if (!Number.isFinite(parsedDays) || !Number.isInteger(parsedDays)) {
      setError("Inactivity threshold must be a whole number of days.");
      return;
    }
    if (parsedDays < CUSTOMER_REACTIVATION_INACTIVITY_DAYS_MIN || parsedDays > CUSTOMER_REACTIVATION_INACTIVITY_DAYS_MAX) {
      setError(`Inactivity threshold must be between ${CUSTOMER_REACTIVATION_INACTIVITY_DAYS_MIN} and ${CUSTOMER_REACTIVATION_INACTIVITY_DAYS_MAX} days.`);
      return;
    }

    startTransition(async () => {
      const result = await updateCustomerReactivationConfig(parsedDays, respectBusinessHours);
      if (result.error) {
        setError(result.error);
        return;
      }
      const newDays = (result.config?.inactivity_days as number | undefined) ?? parsedDays;
      const newRespectHours = (result.config?.respect_business_hours as boolean | undefined) ?? respectBusinessHours;
      setSavedDays(newDays);
      setSavedRespectHours(newRespectHours);
      setInputValue(String(newDays));
      setRespectHours(newRespectHours);
      setSuccess(true);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    });
  }

  function handleSave() {
    commit(Number(inputValue), respectHours);
  }

  function handleReset() {
    setInputValue(String(DEFAULT_DAYS));
    setRespectHours(DEFAULT_RESPECT_HOURS);
    commit(DEFAULT_DAYS, DEFAULT_RESPECT_HOURS);
  }

  return (
    <SectionCard title="Reactivation threshold" description="Choose how long since a customer's last completed job before they're offered a single re-engagement message." icon={Settings}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setSuccess(false);
          }}
          disabled={isPending}
          aria-label="Inactivity threshold, in days"
          className="w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 shadow-sm transition-colors focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="text-sm text-slate-700">days</span>
      </div>

      <BusinessHoursToggleField
        checked={respectHours}
        onChange={(next) => {
          setRespectHours(next);
          setSuccess(false);
        }}
        disabled={isPending}
        hasBusinessHoursConfigured={hasBusinessHoursConfigured}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={handleSave} disabled={isPending || !isDirty} className={primaryButtonAutoClass}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={isPending || isAtDefault}
          className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-500"
        >
          Reset to default
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Changes apply to future reactivation runs only - anything already sent or in progress is unaffected.</p>
      {success && !error ? <p className="mt-1.5 text-xs text-emerald-700">Saved.</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </SectionCard>
  );
}
