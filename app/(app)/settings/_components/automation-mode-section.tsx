"use client";

import { useActionState } from "react";
import { Radio } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { detailLabelClass, detailValueClass, metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import { updateAutomationMode, type SettingsActionState } from "../actions";
import type { AutomationMode } from "@/lib/settings/queries";

const initialState: SettingsActionState = {};

/**
 * Fast-Track Production Readiness, Pass 3: go-live protection. New
 * organizations start in Test mode, where lib/automation/outbound-gate.ts
 * blocks every customer-facing automated send regardless of what any other
 * check decides - nothing here can weaken that gate, this only flips the
 * stored value it reads. Manual CRM work (creating leads, appointments,
 * etc.) is unaffected in either mode. Mirrors the existing per-conversation
 * "Enable AI / Disable AI" toggle's shape exactly - a small hidden-field
 * form, not a new UI pattern.
 */
export function AutomationModeSection({ mode, canEdit }: { mode: AutomationMode; canEdit: boolean }) {
  const [state, action, pending] = useActionState(updateAutomationMode, initialState);
  const isLive = mode === "live";
  const nextMode: AutomationMode = isLive ? "test" : "live";

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={subsectionTitleClass}>Automation Mode</h2>
          <p className={`mt-1 ${metaClass}`}>
            While in Test mode, no customer-facing automated message can be sent - manual CRM work is unaffected.
          </p>
        </div>
        <Badge tone={isLive ? "success" : "neutral"}>{isLive ? "Live" : "Test"}</Badge>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3">
        <div>
          <p className={detailLabelClass}>Current mode</p>
          <p className={detailValueClass}>
            {isLive ? "Live — automation can message real customers" : "Test — automated sends are blocked"}
          </p>
        </div>
        {canEdit ? (
          <form action={action}>
            <input type="hidden" name="mode" value={nextMode} />
            <button
              type="submit"
              disabled={pending}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Radio className="h-4 w-4 shrink-0" aria-hidden />
              {pending ? "Updating…" : isLive ? "Switch to Test" : "Go Live"}
            </button>
          </form>
        ) : null}
      </div>
      {state.error ? <p className="mt-2 text-xs text-danger-text">{state.error}</p> : null}
    </section>
  );
}
