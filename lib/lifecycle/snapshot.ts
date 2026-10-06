/**
 * P0-B B1: the typed facts the canonical lifecycle is derived from - one
 * contact's leads, appointments, estimates, jobs, invoices, review/referral
 * requests and message timeline, plus the organization's lifecycle policy.
 * A snapshot carries its own `asOf` instant and policy, so deriving from it
 * is a pure function of the snapshot alone.
 *
 * Built by loadLifecycleSnapshot (snapshot-loader.ts) from the database, or
 * by hand in tests and in future callers that already hold the rows.
 */

export type LifecyclePolicy = {
  /** Customer reactivation inactivity_days (default 180) - when a past customer becomes dormant. */
  dormancyDays: number;
  /** Estimate follow-up followup_1_hours (default 24) - when a sent estimate enters follow-up. */
  estimateFollowupHours: number;
  /** INVOICING_LIVE_AT - jobs completed before it are never "invoicing". */
  invoicingLiveAt: string;
};

export type SnapshotLead = { id: string; status: string; createdAt: string };
export type SnapshotAppointment = { id: string; leadId: string | null; status: string; startAt: string; endAt: string | null; createdAt: string | null };
export type SnapshotEstimate = { id: string; leadId: string | null; status: string; sentAt: string | null; expiresAt: string | null; createdAt: string };
export type SnapshotJob = { id: string; leadId: string | null; estimateId: string | null; status: string; createdAt: string; completedAt: string | null };
export type SnapshotInvoice = { id: string; jobId: string | null; status: string; dueDate: string | null };
export type SnapshotRequest = { id: string; jobId: string | null; status: string; requestedAt: string | null };
export type SnapshotMessage = { direction: "inbound" | "outbound"; status: string | null; createdAt: string };

export type LifecycleSnapshot = {
  contactId: string;
  /** The instant the snapshot describes (ISO). */
  asOf: string;
  policy: LifecyclePolicy;
  smsOptOut: boolean;
  leads: SnapshotLead[];
  appointments: SnapshotAppointment[];
  estimates: SnapshotEstimate[];
  jobs: SnapshotJob[];
  invoices: SnapshotInvoice[];
  reviewRequests: SnapshotRequest[];
  referralRequests: SnapshotRequest[];
  /** The contact's messages (any conversation), most recent window. */
  messages: SnapshotMessage[];
  /** Types of the contact's OPEN opportunities rows - informational only (they are derived from the same rows and may lag); never used to decide the stage. */
  openOpportunityTypes: string[];
};
