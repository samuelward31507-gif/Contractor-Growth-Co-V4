"use client";

/**
 * Automation Configuration V2.2 - the shared checkbox + warning row used by
 * both InstantLeadFollowupConfigForm and InboundCustomerReplyConfigForm.
 * Purely presentational and controlled - the owning form holds the actual
 * checked/dirty/saving state and decides when to call its Server Action.
 */
export function BusinessHoursToggleField({
  checked,
  onChange,
  disabled,
  hasBusinessHoursConfigured,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  hasBusinessHoursConfigured: boolean;
}) {
  return (
    <div className="mt-3">
      <label className="flex min-h-11 items-center gap-2 text-sm text-ink-2 sm:min-h-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="h-4 w-4 rounded border-line-strong text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/10 disabled:cursor-not-allowed"
        />
        Only send automatically during business hours
      </label>
      {checked && !hasBusinessHoursConfigured ? (
        <p className="mt-1.5 text-xs text-warning-text">No business hours are configured. This setting will have no effect until business hours are added.</p>
      ) : null}
    </div>
  );
}
