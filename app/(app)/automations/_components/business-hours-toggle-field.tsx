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
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400 disabled:cursor-not-allowed"
        />
        Only send automatically during business hours
      </label>
      {checked && !hasBusinessHoursConfigured ? (
        <p className="mt-1.5 text-xs text-amber-600">No business hours are configured. This setting will have no effect until business hours are added.</p>
      ) : null}
    </div>
  );
}
