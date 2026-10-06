import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupStage } from "./config";
import { canTransition, type FollowupNextAction, type FollowupState, type FollowupWaitingOn } from "./state";

/** P0 A4: the followups row shape and its single, state-machine-checked write path. */
export const FOLLOWUP_AUTOMATION_ID = "lead-followup-sequence";

export type FollowupRow = {
  id: string;
  organization_id: string;
  lead_id: string;
  stage: FollowupStage;
  state: FollowupState;
  waiting_on: FollowupWaitingOn;
  next_action: FollowupNextAction;
  next_action_at: string | null;
  attempt_count: number;
  lease_until: string | null;
  paused_reason: string | null;
  exit_reason: string | null;
  last_execution_id: string | null;
  reactivated_at: string | null;
  created_at: string;
};

export const FOLLOWUP_COLUMNS = "id, organization_id, lead_id, stage, state, waiting_on, next_action, next_action_at, attempt_count, lease_until, paused_reason, exit_reason, last_execution_id, reactivated_at, created_at";

export type Fields = Partial<Omit<FollowupRow, "id" | "organization_id" | "lead_id" | "stage" | "created_at">>;

/**
 * The only write path for a state change: refused unless the state machine
 * allows from -> to, and conditional on the row still being in `from` (and,
 * for a claimed row, still holding the same lease) - so a writer that lost a
 * race changes nothing.
 */
export async function transitionFollowup(
  service: SupabaseClient,
  row: Pick<FollowupRow, "id" | "state" | "lease_until">,
  to: FollowupState,
  fields: Fields = {},
): Promise<FollowupRow | null> {
  if (!canTransition(row.state, to)) {
    throw new Error(`Follow-up ${row.id}: illegal transition ${row.state} -> ${to}`);
  }
  let query = service.from("followups").update({ ...fields, state: to }).eq("id", row.id).eq("state", row.state);
  if (row.state === "processing" && row.lease_until) query = query.eq("lease_until", row.lease_until);
  const { data, error } = await query.select(FOLLOWUP_COLUMNS);
  if (error) {
    console.error("[followups] transition failed", { followupId: row.id, from: row.state, to, error: error.message });
    return null;
  }
  return ((data ?? []) as FollowupRow[])[0] ?? null;
}

