import type { ActionKind, AutonomyLevel, Recommendation } from "./contract";

/**
 * Agent Operating Layer, Phase 1: the approval model.
 *
 * Every recommendation names the kind of action it proposes. Anything that
 * would change the world outside Trackpr's own screens - a customer
 * message, an email, a production change, billing, data deletion,
 * credentials, integrations, any destructive operation - always requires an
 * explicit human yes, whatever the agent claimed. No agent is autonomous in
 * Phase 1, and nothing in this layer executes an action: a recommendation
 * is text plus an in-app link to the existing, already-gated screen where a
 * person can act (for example, a customer reply still goes through
 * evaluateOutboundGate in lib/automation/outbound-gate.ts).
 */

export const SENSITIVE_ACTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "send_customer_message",
  "send_email",
  "contact_prospect",
  "change_production",
  "deploy_code",
  "modify_billing",
  "delete_data",
  "change_credentials",
  "change_integrations",
  "destructive_operation",
]);

export function actionRequiresApproval(actionKind: ActionKind): boolean {
  return SENSITIVE_ACTION_KINDS.has(actionKind);
}

const AUTONOMY_ORDER: AutonomyLevel[] = ["read_only", "recommend", "requires_approval", "autonomous"];
const autonomyIndex = (level: AutonomyLevel) => AUTONOMY_ORDER.indexOf(level);

/** Phase 1 ceiling for every agent. Raising it is a deliberate, reviewed code change - never configuration. */
export const PHASE_1_MAX_AUTONOMY: AutonomyLevel = "recommend";

export type PolicyAdjustment = { recommendationId: string; reason: "sensitive_action" | "above_agent_ceiling" | "autonomy_not_permitted" | "approval_flag_mismatch" };

/**
 * Applies the approval model to one recommendation. Returns the corrected
 * recommendation and why it changed (if it did). Never loosens anything:
 *  - a sensitive action is always requires_approval with requiresApproval = true;
 *  - "autonomous" is never permitted in Phase 1 and becomes requires_approval;
 *  - any other claim above the agent's ceiling becomes requires_approval;
 *  - requiresApproval is always true when the resulting level is requires_approval,
 *    and an agent's own approval request is never dropped.
 */
export function enforceRecommendationPolicy(recommendation: Recommendation, agentCeiling: AutonomyLevel): { recommendation: Recommendation; adjustment: PolicyAdjustment | null } {
  let autonomy = recommendation.autonomy;
  let reason: PolicyAdjustment["reason"] | null = null;

  if (actionRequiresApproval(recommendation.actionKind)) {
    if (autonomy !== "requires_approval") reason = "sensitive_action";
    autonomy = "requires_approval";
  } else if (autonomy === "autonomous") {
    autonomy = "requires_approval";
    reason = "autonomy_not_permitted";
  } else if (autonomyIndex(autonomy) > autonomyIndex(agentCeiling)) {
    autonomy = "requires_approval";
    reason = "above_agent_ceiling";
  }

  // An agent that asked for approval keeps the request even on a harmless
  // action; the flag and the level are then made to agree.
  if (recommendation.requiresApproval && autonomy !== "requires_approval") {
    autonomy = "requires_approval";
    reason ??= "approval_flag_mismatch";
  }
  const requiresApproval = autonomy === "requires_approval";
  if (reason === null && requiresApproval !== recommendation.requiresApproval) reason = "approval_flag_mismatch";

  return {
    recommendation: { ...recommendation, autonomy, requiresApproval },
    adjustment: reason ? { recommendationId: recommendation.id, reason } : null,
  };
}
