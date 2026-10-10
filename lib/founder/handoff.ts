/**
 * Deal-to-client handoff - the pure part shared by the Founder deal view and
 * the Agency handoffs page. The rules mirror the database
 * (supabase/pending/agency_client_handoff.sql), which enforces them again:
 *
 *  - Only a Won deal with agreed setup + monthly fees, a decision-maker name,
 *    an email or phone, and a written scope can be handed off.
 *  - Preparing copies just those fields; it creates no client.
 *  - An agency admin confirms separately; only then does an Agency client
 *    exist. A deal hands off once (a cancelled handoff can be redone).
 *
 * Founder deals, Agency clients and Trackpr contractor customers stay
 * separate: nothing here creates an organization or a contractor customer.
 */
import type { FounderDeal } from "./model";
import type { ClientHandoff } from "@/lib/agency/handoff-records";

// The handoff record (type, columns, row mapping, missing-table check) lives
// with the agency, which owns the table; re-exported so founder imports are unchanged.
export { HANDOFF_COLUMNS, isMissingHandoffTable, toHandoff, type ClientHandoff, type HandoffStatus } from "@/lib/agency/handoff-records";

export const SCOPE_MIN = 10;
export const SCOPE_MAX = 5000;

/** What a deal still needs before it can be handed off (deal fields only; the scope is asked for when preparing). */
export function handoffMissing(deal: Pick<FounderDeal, "stage" | "wonSetupFee" | "wonMonthlyFee" | "contactName" | "contactEmail" | "contactPhone">): string[] {
  const missing: string[] = [];
  if (deal.stage !== "won") missing.push("the deal must be won");
  if (deal.wonSetupFee == null || deal.wonMonthlyFee == null) missing.push("agreed setup and monthly fees");
  if (!deal.contactName?.trim()) missing.push("a decision-maker name");
  if (!deal.contactEmail?.trim() && !deal.contactPhone?.trim()) missing.push("a contact email or phone");
  return missing;
}

export function parseScope(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (value.length < SCOPE_MIN) return { ok: false, error: `Describe the agreed scope (at least ${SCOPE_MIN} characters).` };
  if (value.length > SCOPE_MAX) return { ok: false, error: `Keep the scope under ${SCOPE_MAX.toLocaleString("en-US")} characters.` };
  return { ok: true, value };
}

export type HandoffState =
  /** Not a won deal - handoff doesn't apply yet. */
  | { kind: "not_won" }
  | { kind: "missing_info"; missing: string[]; cancelled: ClientHandoff[] }
  | { kind: "ready"; cancelled: ClientHandoff[] }
  | { kind: "prepared"; handoff: ClientHandoff; cancelled: ClientHandoff[] }
  | { kind: "confirmed"; handoff: ClientHandoff; cancelled: ClientHandoff[]; dealReopened: boolean };

/**
 * Where a deal stands in the handoff. A confirmed handoff stays confirmed
 * even if the deal was later reopened (the client exists) - that's flagged,
 * never hidden. Cancelled handoffs are kept as history.
 */
export function handoffState(deal: FounderDeal, handoffs: ClientHandoff[]): HandoffState {
  const mine = handoffs.filter((h) => h.dealId === deal.id).sort((a, b) => (a.preparedAt < b.preparedAt ? 1 : -1));
  const live = mine.find((h) => h.status !== "cancelled");
  const cancelled = mine.filter((h) => h.status === "cancelled");
  if (live?.status === "confirmed") return { kind: "confirmed", handoff: live, cancelled, dealReopened: deal.stage !== "won" };
  if (deal.stage !== "won") return live ? { kind: "prepared", handoff: live, cancelled } : { kind: "not_won" };
  if (live) return { kind: "prepared", handoff: live, cancelled };
  const missing = handoffMissing(deal);
  return missing.length ? { kind: "missing_info", missing, cancelled } : { kind: "ready", cancelled };
}

/** A prepared handoff whose deal no longer matches what was prepared (the database will refuse to confirm it). */
export function handoffOutOfDate(handoff: ClientHandoff, deal: Pick<FounderDeal, "stage" | "name" | "contactName" | "contactEmail" | "contactPhone" | "wonSetupFee" | "wonMonthlyFee" | "currency">): boolean {
  const norm = (v: string | null) => (v ?? "").trim() || null;
  return (
    deal.stage !== "won" ||
    deal.name.trim() !== handoff.clientName ||
    norm(deal.contactName) !== handoff.contactName ||
    norm(deal.contactEmail) !== handoff.contactEmail ||
    norm(deal.contactPhone) !== handoff.contactPhone ||
    deal.wonSetupFee !== handoff.setupFee ||
    deal.wonMonthlyFee !== handoff.monthlyFee ||
    deal.currency !== handoff.currency
  );
}
