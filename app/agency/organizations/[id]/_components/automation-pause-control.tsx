"use client";

import { useState } from "react";
import { useActionState } from "react";
import { Pause, Play } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { destructiveButtonAutoClass, ghostButtonClass, primaryButtonSmallClass, secondaryButtonSmallClass, errorBannerClass } from "@/lib/ui/form";
import { setAutomationPaused, type SetAutomationPausedState } from "../../actions";

const initialState: SetAutomationPausedState = {};

/**
 * Launch Blocker #5: the founder-facing kill switch UI. Reflects the exact
 * persisted organizations.automation_paused value this page read server-side
 * (isPaused prop) - never a locally-guessed/optimistic state - so a page
 * reload always shows what's actually enforced, not what a button click
 * implied. Real enforcement lives in lib/automation/outbound-gate.ts; this
 * is the control surface, not the boundary itself.
 */
export function AutomationPauseControl({ organizationId, isPaused }: { organizationId: string; isPaused: boolean }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pauseState, pauseFormAction, isPausing] = useActionState(setAutomationPaused, initialState);
  const [resumeState, resumeFormAction, isResuming] = useActionState(setAutomationPaused, initialState);

  // Derived, not synced via an effect: once the pause actually succeeds, the
  // dialog stops rendering immediately. It can never spuriously reopen from
  // a stale pauseState.success, since once isPaused flips to true (via the
  // action's revalidatePath) this entire branch - Pause button and dialog
  // alike - stops rendering altogether.
  const dialogOpen = confirmOpen && !pauseState.success;

  return (
    <div className="flex items-center gap-2">
      {isPaused ? (
        <>
          <Badge tone="warning">Automation: PAUSED</Badge>
          <form action={resumeFormAction}>
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="paused" value="false" />
            {resumeState.error ? <p className={`mb-1.5 ${errorBannerClass}`}>{resumeState.error}</p> : null}
            <button type="submit" disabled={isResuming} className={primaryButtonSmallClass}>
              <Play className="h-3.5 w-3.5" aria-hidden />
              {isResuming ? "Resuming…" : "Resume"}
            </button>
          </form>
        </>
      ) : (
        <>
          <Badge tone="success">Automation: ON</Badge>
          <button type="button" onClick={() => setConfirmOpen(true)} className={secondaryButtonSmallClass}>
            <Pause className="h-3.5 w-3.5" aria-hidden />
            Pause
          </button>
        </>
      )}

      {dialogOpen ? (
        <Dialog onClose={() => setConfirmOpen(false)} labelledBy="pause-automation-title">
          <DialogTitle id="pause-automation-title">Pause automation for this client?</DialogTitle>
          <DialogDescription>
            This immediately stops all automated outbound messaging and automation for this organization - no
            automated SMS will send until you resume it. Existing conversations, leads, and data are unaffected.
          </DialogDescription>

          {pauseState.error ? <p className={`mt-4 ${errorBannerClass}`}>{pauseState.error}</p> : null}

          <form action={pauseFormAction}>
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="paused" value="true" />
            <DialogFooter>
              <button type="button" onClick={() => setConfirmOpen(false)} className={ghostButtonClass}>
                Cancel
              </button>
              <button type="submit" disabled={isPausing} className={destructiveButtonAutoClass}>
                {isPausing ? "Pausing…" : "Pause Automation"}
              </button>
            </DialogFooter>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
