import type { SupabaseClient } from "@supabase/supabase-js";
import { getBusinessProfile, getServiceAreas } from "@/lib/settings/queries";
import { computeOnboardingReadiness, getLatestTestLeadOutcome, type OnboardingReadiness, type TestLeadOutcome } from "./readiness";

/**
 * First Contractor Onboarding + Internal Client Setup System, Phase 3/4:
 * built strictly on top of computeOnboardingReadiness (lib/onboarding/
 * readiness.ts) - never a second, competing readiness computation. That
 * function's own `status`/`items` shape is untouched (existing callers -
 * the onboarding hub's core checklist, the agency page's existing card, and
 * readiness.integration.test.ts - all keep working exactly as before); this
 * module only adds the fuller, factual setup checklist and a derived
 * lifecycle stage the agency-facing views need, reusing the exact same
 * underlying reads (business profile, business hours, SMS, lead capture,
 * automation mode) plus service areas and the real test-lead outcome.
 *
 * Every item's `complete` is read directly from real configuration state -
 * nothing here is a subjective score, and nothing can read as complete
 * unless it verifiably is (Phase 9: never a green success state for
 * something actually blocked).
 */
export type SetupChecklistItem = {
  key: "business" | "trade" | "serviceArea" | "hours" | "sms" | "leadCapture" | "testCompleted" | "testVerified" | "goLive";
  label: string;
  complete: boolean;
};

export type OnboardingStage = "new" | "configuring" | "testing" | "ready" | "live";

export const ONBOARDING_STAGE_LABEL: Record<OnboardingStage, string> = {
  new: "New",
  configuring: "Configuring",
  testing: "Testing",
  ready: "Ready",
  live: "Live",
};

export type SetupChecklist = {
  stage: OnboardingStage;
  items: SetupChecklistItem[];
  readiness: OnboardingReadiness;
  testLeadOutcome: TestLeadOutcome | null;
};

function findItem(readiness: OnboardingReadiness, key: "business" | "hours" | "leadCapture" | "sms"): boolean {
  return readiness.items.find((item) => item.key === key)?.complete ?? false;
}

/**
 * A test lead is "verified" once its execution genuinely completed and was
 * either actually sent or correctly held back for the one expected,
 * by-design reason: organization_not_live (the app/onboarding/test-lead-panel.tsx
 * UI already treats this exact case as a success - "this is exactly what
 * should happen" - since Go Live is only ever reachable from Test mode,
 * where outbound-gate.ts's organization_not_live check always fires by
 * design; requiring blockedReason === null here would make this item
 * permanently unreachable before Go Live, which is not what "verified"
 * should mean). Any other outcome - still running, or blocked/failed for a
 * different reason (e.g. the known n8n webhook 404) - correctly stays
 * unverified, matching what the test-lead panel itself shows as a warning.
 */
function isTestVerified(outcome: TestLeadOutcome | null): boolean {
  if (!outcome || outcome.executionStatus !== "completed") return false;
  return outcome.blockedReason === null || outcome.blockedReason === "organization_not_live";
}

export async function computeSetupChecklist(supabase: SupabaseClient, organizationId: string): Promise<SetupChecklist> {
  const [readiness, profile, serviceAreas, testLeadOutcome] = await Promise.all([
    computeOnboardingReadiness(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
    getServiceAreas(supabase, organizationId),
    getLatestTestLeadOutcome(supabase, organizationId),
  ]);

  const businessComplete = findItem(readiness, "business");
  const tradeComplete = Boolean(profile?.trade);
  const serviceAreaComplete = serviceAreas.length > 0;
  const hoursComplete = findItem(readiness, "hours");
  const smsComplete = findItem(readiness, "sms");
  const leadCaptureComplete = findItem(readiness, "leadCapture");
  const testAttempted = testLeadOutcome !== null;
  const testVerified = isTestVerified(testLeadOutcome);
  const isLive = readiness.automationMode === "live";

  const items: SetupChecklistItem[] = [
    { key: "business", label: "Business profile", complete: businessComplete },
    { key: "trade", label: "Trade configured", complete: tradeComplete },
    { key: "serviceArea", label: "Service area configured", complete: serviceAreaComplete },
    { key: "hours", label: "Business hours", complete: hoursComplete },
    { key: "sms", label: "SMS configured", complete: smsComplete },
    { key: "leadCapture", label: "Lead capture", complete: leadCaptureComplete },
    { key: "testCompleted", label: "Automation test completed", complete: testAttempted },
    { key: "testVerified", label: "Test lead verified", complete: testVerified },
    { key: "goLive", label: "Go Live approved", complete: isLive },
  ];

  const coreConfigured = businessComplete && hoursComplete && smsComplete && leadCaptureComplete;

  let stage: OnboardingStage;
  if (isLive) {
    stage = "live";
  } else if (!businessComplete) {
    stage = "new";
  } else if (!coreConfigured) {
    stage = "configuring";
  } else if (!testVerified) {
    stage = "testing";
  } else {
    stage = "ready";
  }

  return { stage, items, readiness, testLeadOutcome };
}

export type GoLiveCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * First Contractor Onboarding + Internal Client Setup System, Phase 8: the
 * single, shared definition of "safe to flip to Live" - consulted by
 * app/(app)/settings/actions.ts's updateAutomationMode (the only place that
 * actually flips organizations.automation_mode) so there is exactly one
 * definition of Go Live readiness, never a second one that could drift out
 * of sync with what the setup checklist itself shows as complete. Does NOT
 * require a verified test lead - that depends on n8n being reachable (see
 * isTestVerified's own reasoning above), and the known, already-escalated
 * webhook issue must never make Go Live permanently unreachable.
 */
export function canGoLive(checklist: Pick<SetupChecklist, "items">): GoLiveCheck {
  const find = (key: SetupChecklistItem["key"]) => checklist.items.find((item) => item.key === key)?.complete ?? false;

  if (!find("business")) {
    return { allowed: false, reason: "Complete your business profile (name and phone) before going live." };
  }
  if (!find("hours")) {
    return { allowed: false, reason: "Set your business hours before going live." };
  }
  if (!find("sms")) {
    return { allowed: false, reason: "Configure an SMS routing number before going live, so customer replies can reach Trackpr." };
  }
  return { allowed: true };
}
