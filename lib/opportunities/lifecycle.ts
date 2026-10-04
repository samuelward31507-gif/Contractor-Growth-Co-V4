import { OPEN_LEAD_STATUSES, type LeadStatus } from "@/lib/leads/queries";

/**
 * Phase 2-8: the shared revenue-lifecycle rules behind two Today opportunity
 * types and the matching Insights figures - one definition, used by both
 * lib/opportunities/detect.ts and lib/bi/metrics.ts, so Today and Insights
 * can never silently disagree. Pure: no I/O; callers read the rows (paged)
 * and pass them in. Every time comparison is between instants (ms since
 * epoch), never strings, so an offset-written timestamp compares correctly.
 *
 * There is no appointment_id on estimates or jobs, so every match goes
 * through the lead, or - only when a row has no lead - through the contact,
 * with a timestamp rule that keeps old customer history out.
 */

/** An appointment in one of these statuses books a lead (cancelled and no-show never do; completed does - L5/L1). */
export const BOOKED_APPOINTMENT_STATUSES = ["scheduled", "confirmed", "completed"] as const;

export type LifecycleLead = { id: string; contact_id: string | null; created_at: string; status: string };
export type LifecycleAppointment = { id: string; lead_id: string | null; contact_id: string | null; start_at: string; status: string };
export type LifecycleEstimate = { lead_id: string | null; contact_id: string | null; created_at: string };
export type LifecycleJob = { lead_id: string | null };

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : Number.NaN);
const isOpenLead = (lead: LifecycleLead) => OPEN_LEAD_STATUSES.has(lead.status as LeadStatus);

/**
 * Phase 2-7 (A10, L5), moved here unchanged for Insights parity: the
 * qualified leads with no booking. A booked-status appointment books a lead
 * when it is linked to that lead by lead_id, or - only when it has no
 * lead_id - when it is for the lead's own contact and starts at or after the
 * lead was created. An appointment linked to a different lead never books
 * this one.
 */
export function findUnbookedQualifiedLeads<L extends LifecycleLead>(leads: L[], appointments: Omit<LifecycleAppointment, "id">[]): L[] {
  const booked = appointments.filter((row) => (BOOKED_APPOINTMENT_STATUSES as readonly string[]).includes(row.status));
  const bookedLeadIds = new Set<string>();
  // Per contact, the latest start of a booked appointment that has no lead_id.
  const latestLeadlessStartMsByContact = new Map<string, number>();
  for (const row of booked) {
    if (row.lead_id !== null) {
      bookedLeadIds.add(row.lead_id);
    } else if (row.contact_id !== null) {
      const startMs = ms(row.start_at);
      if (startMs > (latestLeadlessStartMsByContact.get(row.contact_id) ?? Number.NEGATIVE_INFINITY)) latestLeadlessStartMsByContact.set(row.contact_id, startMs);
    }
  }
  return leads.filter(
    (lead) =>
      lead.status === "qualified" &&
      !bookedLeadIds.has(lead.id) &&
      !(lead.contact_id !== null && (latestLeadlessStartMsByContact.get(lead.contact_id) ?? Number.NEGATIVE_INFINITY) >= ms(lead.created_at)),
  );
}

export type CompletedVisitWithoutEstimate<V extends LifecycleAppointment> = {
  leadId: string;
  /** The lead's latest completed visit - the opportunity's source (M5). */
  anchor: V;
  /** Every completed visit associated with the lead, the anchor included - a dismissal of any of them suppresses the lead's item (M5). */
  visitIds: string[];
};

/**
 * Phase 2-8 (M1-M5, M8): one item per open lead that has a completed visit
 * and no estimate and no job.
 *
 * Association (M1, M2, M3, M4):
 *   - a visit linked by lead_id belongs to that lead, but only if the lead
 *     is open (new, contacted, qualified, appointment, estimate) - a won or
 *     lost lead never has a "no estimate" item;
 *   - a visit with no lead_id belongs to the most recently created open
 *     lead of the same contact that was created at or before the visit's
 *     start (ties: highest id). With no such lead it is never flagged -
 *     there is no reliable lead to attach it to.
 *
 * Cleared (M4, M5/L5, M8) - the lead has no item when any of these exist:
 *   - an estimate linked to the lead, in any status (draft, sent, accepted,
 *     declined, cancelled, expired);
 *   - an estimate with no lead_id for the lead's contact (or a visit's
 *     contact) created at or after the lead's earliest associated visit;
 *   - a job linked to the lead.
 *
 * Anchor (M5): the lead's latest completed visit by start (ties: highest
 * id). Results are ordered by anchor id.
 */
export function findCompletedVisitsWithoutEstimate<V extends LifecycleAppointment>(input: {
  visits: V[];
  leads: LifecycleLead[];
  estimates: LifecycleEstimate[];
  jobs: LifecycleJob[];
}): CompletedVisitWithoutEstimate<V>[] {
  const openLeads = input.leads.filter(isOpenLead);
  const openLeadById = new Map(openLeads.map((lead) => [lead.id, lead]));
  const openLeadsByContact = new Map<string, LifecycleLead[]>();
  for (const lead of openLeads) {
    if (lead.contact_id === null) continue;
    const list = openLeadsByContact.get(lead.contact_id) ?? [];
    list.push(lead);
    openLeadsByContact.set(lead.contact_id, list);
  }

  const associate = (visit: V): LifecycleLead | null => {
    if (visit.lead_id !== null) return openLeadById.get(visit.lead_id) ?? null;
    if (visit.contact_id === null) return null;
    const startMs = ms(visit.start_at);
    if (Number.isNaN(startMs)) return null;
    let best: LifecycleLead | null = null;
    for (const lead of openLeadsByContact.get(visit.contact_id) ?? []) {
      const createdMs = ms(lead.created_at);
      if (!(createdMs <= startMs)) continue;
      if (best === null || createdMs > ms(best.created_at) || (createdMs === ms(best.created_at) && lead.id > best.id)) best = lead;
    }
    return best;
  };

  const visitsByLead = new Map<string, V[]>();
  for (const visit of input.visits) {
    if (visit.status !== "completed") continue;
    const lead = associate(visit);
    if (!lead) continue;
    const list = visitsByLead.get(lead.id) ?? [];
    list.push(visit);
    visitsByLead.set(lead.id, list);
  }

  const leadIdsWithEstimate = new Set(input.estimates.map((row) => row.lead_id).filter((id): id is string => id !== null));
  const leadIdsWithJob = new Set(input.jobs.map((row) => row.lead_id).filter((id): id is string => id !== null));
  const latestLeadlessEstimateMsByContact = new Map<string, number>();
  for (const row of input.estimates) {
    if (row.lead_id !== null || row.contact_id === null) continue;
    const createdMs = ms(row.created_at);
    if (createdMs > (latestLeadlessEstimateMsByContact.get(row.contact_id) ?? Number.NEGATIVE_INFINITY)) latestLeadlessEstimateMsByContact.set(row.contact_id, createdMs);
  }

  const results: CompletedVisitWithoutEstimate<V>[] = [];
  for (const [leadId, visits] of visitsByLead) {
    if (leadIdsWithEstimate.has(leadId) || leadIdsWithJob.has(leadId)) continue;
    const earliestVisitMs = Math.min(...visits.map((visit) => ms(visit.start_at)).filter((value) => !Number.isNaN(value)));
    const contacts = new Set([openLeadById.get(leadId)!.contact_id, ...visits.map((visit) => visit.contact_id)].filter((id): id is string => id !== null));
    const leadlessEstimateAfterVisit = [...contacts].some((contactId) => (latestLeadlessEstimateMsByContact.get(contactId) ?? Number.NEGATIVE_INFINITY) >= earliestVisitMs);
    if (leadlessEstimateAfterVisit) continue;
    const anchor = visits.reduce((latest, visit) => {
      const [a, b] = [ms(visit.start_at), ms(latest.start_at)];
      return a > b || (a === b && visit.id > latest.id) ? visit : latest;
    });
    results.push({ leadId, anchor, visitIds: visits.map((visit) => visit.id).sort() });
  }
  return results.sort((a, b) => (a.anchor.id < b.anchor.id ? -1 : a.anchor.id > b.anchor.id ? 1 : 0));
}
