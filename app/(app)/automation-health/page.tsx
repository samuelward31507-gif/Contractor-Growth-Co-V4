import { redirect } from "next/navigation";

/**
 * Trackpr 2.0 Phase 4: Automation Health was consolidated into /automations
 * (its overview hero, active incidents, and per-automation health are all
 * shown there now - see app/(app)/automations/page.tsx's own comment). Kept
 * as a redirect, not deleted, so any bookmarked or externally-linked
 * /automation-health URL keeps working instead of 404ing - the same pattern
 * used for the /activity -> /analytics rename in Phase 1.
 */
export default function LegacyAutomationHealthRedirect() {
  redirect("/automations");
}
