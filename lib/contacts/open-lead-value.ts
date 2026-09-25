/**
 * Pass 4 P1-F: the contact detail page's own "Open opportunity value" stat
 * used to reduce `lead.estimated_value ?? 0`, silently turning a lead with
 * an unknown estimated value into a displayed $0 - indistinguishable from a
 * lead genuinely worth nothing. Extracted into a pure, exported function so
 * the NULL-handling fix is directly unit-testable, matching this
 * codebase's established pattern (e.g. lib/opportunities/queries.ts's
 * summarizeOpportunities) for exactly this class of bug. Lives in
 * lib/contacts/, not the [id] route's own _lib folder - Node's test runner
 * treats a literal `[id]` path segment as a glob character class, so a test
 * file placed inside that folder can never actually be discovered by the
 * standard `node --test <path>` invocation this codebase uses everywhere.
 *
 * Deliberately NOT a change to lib/leads/queries.ts's summarizeLeads -
 * that function has the same underlying pattern but is used more broadly
 * (dashboard, leads list) and fixing it is out of this pass's stated scope
 * ("fix this while working in the contact page ONLY if needed... do not
 * redesign the lead value model").
 */

export type OpenLeadValueSummary = {
  /** SUM(lead.estimated_value) over open (not won/lost) leads with a non-null value. */
  knownValue: number;
  /** Count of open leads whose estimated_value is NULL. */
  unknownValueCount: number;
};

const CLOSED_LEAD_STATUSES = new Set(["won", "lost"]);

export function summarizeOpenLeadValue(leads: { status: string; estimated_value: number | null }[]): OpenLeadValueSummary {
  let knownValue = 0;
  let unknownValueCount = 0;
  for (const lead of leads) {
    if (CLOSED_LEAD_STATUSES.has(lead.status)) continue;
    if (lead.estimated_value != null) knownValue += lead.estimated_value;
    else unknownValueCount += 1;
  }
  return { knownValue, unknownValueCount };
}

/**
 * Never displays $0 when the real value is unknown - a real $0 known value
 * is indistinguishable from "no leads counted at all" without this check,
 * so it only ever applies when there is at least one open lead and at
 * least one of them has an unknown value.
 */
export function formatOpenLeadValueDisplay(summary: OpenLeadValueSummary, openLeadCount: number, formatCurrency: (value: number) => string): string {
  if (openLeadCount > 0 && summary.knownValue === 0 && summary.unknownValueCount > 0) return "Unknown";
  return formatCurrency(summary.knownValue);
}
