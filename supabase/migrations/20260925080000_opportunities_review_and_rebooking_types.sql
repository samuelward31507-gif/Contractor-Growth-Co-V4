-- Pass 5C, Batch 1: adds the two new opportunity types the Pass 5C
-- read-only audit judged safe to build - completed_job_no_review_request
-- and cancelled_appointment_no_rebooking.
--
-- completed_job_no_review_request was deliberately deferred at Pass 3/4
-- (see the removed comment this migration's sibling, 20260925050000, left
-- in lib/opportunities/detect.ts) because a missing review_requests row is
-- ambiguous between "this org has no review_url configured" and "a genuine
-- gap". This is now built WITH that exact ambiguity resolved: the detector
-- (lib/opportunities/detect.ts) only ever considers a job a candidate when
-- organizations.review_url is actually configured - an unconfigured org
-- produces zero candidates, never a false opportunity.
--
-- cancelled_appointment_no_rebooking is an explicit absence-based
-- heuristic, not a true rebooking relationship - this schema has no
-- original_appointment_id/rebooked_from_id column, and this migration does
-- not add one. See the detector's own comment for the exact, documented
-- limitation.
--
-- Both new types' source is already covered by the existing
-- source_entity_type CHECK ('job' and 'appointment' both already allowed,
-- added by 20260925050000/20260922040000 respectively) - only the `type`
-- CHECK needs widening. No new table, no new column, no RLS/index/trigger
-- change, matching 20260925050000's own established pattern exactly - the
-- existing opportunities_select/insert/update/delete policies, the
-- payment-gate restrictive policy, the partial unique dedup index, and the
-- updated_at trigger all already cover any type/source_entity_type value,
-- including these two new ones, since none of them enumerate specific
-- values themselves.
--
-- Dropped and recreated (Postgres has no ALTER CHECK), using the exact live
-- constraint name (verified directly against the database before writing
-- this migration, not assumed) - a rerun-safe, idempotent widening, never a
-- narrowing, so no existing row can ever violate the new constraint.

alter table public.opportunities
  drop constraint if exists opportunities_type_check;

alter table public.opportunities
  add constraint opportunities_type_check
  check (type in (
    'qualified_lead_unbooked',
    'stale_estimate',
    'completed_appointment_no_estimate',
    'dormant_customer',
    'no_show',
    'completed_job_no_referral_request',
    'completed_job_no_review_request',
    'cancelled_appointment_no_rebooking'
  ));
