import type { PriorityTier, RecommendedAction, OpportunityExplanation } from "@/lib/opportunities/intelligence";
import type { IncidentStatus } from "@/lib/automation-health/types";
import type { OpportunityType } from "@/lib/opportunities/queries";
import type { AttentionItem } from "@/lib/dashboard/queries";
import type { StatusTone } from "@/lib/ui/status";
import type { ReasonCode } from "./reason-codes";
import type { DecisionActor } from "./actor";

export type DecisionAct = "attention" | "opportunity" | "system";

/**
 * Phase 2-2: one item a surface can render, whatever produced it - an
 * operational exception, a live conversation/appointment signal or a
 * persisted opportunity. Built by assemble.ts from reads the caller already
 * made; carries every field a Today row renders, already resolved.
 */
export type DecisionItem = {
  /** Stable React key - "opportunity:<id>", "signal:<kind>:<index>", or an exception's incident id / "<kind>-<href>". */
  key: string;
  reasonCode: ReasonCode;
  /** "attention" (Act II) or "opportunity" (Act III). "system" is reserved for future top-bar health items. */
  act: DecisionAct;
  /** True for operational exceptions: always first in Act II, never tiered or scored alongside revenue items. */
  operational: boolean;
  /** Phase 2-3: "trackpr" only while a Trackpr action is still pending for this item (lib/decisions/actor.ts); otherwise "human". */
  actor: DecisionActor;
  /** The priority tier; null for operational exceptions, which are untiered. */
  tier: PriorityTier | null;
  tone: StatusTone;
  problemLabel: string;
  /** Phase 2-11: set when the row is shown as "Missed follow-up · ..." - which of the three kinds (the reason code is unchanged). */
  missedFollowUp?: import("./missed-follow-up").MissedFollowUpKind;
  subject: { name: string; href: string };
  explanation: OpportunityExplanation;
  /** The one-line sentence the row shows. */
  sentence: string;
  /** Formatted money for the row, when the item carries a known value. */
  money?: string;
  /** Relative age ("2 days ago"), when the source records one. */
  age?: string;
  phone: string | null;
  nextAction: {
    /** The resolved recommended action; null for operational exceptions. */
    code: RecommendedAction | null;
    label: string;
    href: string;
    automatable: boolean;
  };
  source:
    | { kind: "exception"; attentionKind: AttentionItem["kind"]; incidentId?: string; incidentStatus?: IncidentStatus }
    | { kind: "signal"; attentionKind: AttentionItem["kind"] }
    | { kind: "opportunity"; opportunityId: string; opportunityType: OpportunityType };
};

export type AssembledDecisions = {
  /** Operational exceptions, in attention-list order. Shown first in Act II. */
  exceptions: DecisionItem[];
  /** Act II's tiered items a human has to act on, in priority order (Phase 2-3b: Trackpr-handled items are not here). */
  attention: DecisionItem[];
  /** Act III's items (recoverable and growth tiers), in priority order. */
  opportunities: DecisionItem[];
  /** Phase 2-3b: Act II items Trackpr is still handling (actor "trackpr"), in priority order - never counted, never shown in Act II. */
  trackprHandling: DecisionItem[];
  /** Phase 2-4b: human-owned pending estimates under 24h old - not attention yet (A3): not shown in Act II, not counted, not in trackprHandling. Still listed in By type. */
  notYetAttention: DecisionItem[];
  /** The one attention count - operational exceptions plus human Act II items: the header line, the Act II count and "You're all caught up" all read it. */
  totalNeedingAttention: number;
};
