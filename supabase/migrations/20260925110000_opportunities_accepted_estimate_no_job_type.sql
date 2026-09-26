-- Pass 5C Batch 7, Item 1: adds the new opportunity type the read-only
-- Batch 6 audit identified as the highest-confidence remaining revenue-leak
-- signal - accepted_estimate_no_job.
--
-- Meaning: an estimate has been accepted (a real, unambiguous customer
-- "yes"), but no job exists for it after a conservative waiting window.
-- Detection (lib/opportunities/detect.ts) uses only real, already-existing
-- facts:
--   - estimates.status = 'accepted' and estimates.responded_at (verified by
--     direct code inspection - set only on the accepted/declined
--     transition, by both the manual staff Accept action and the automated
--     SMS-accept path; never set for draft/sent/cancelled/expired)
--   - jobs.estimate_id (a real, already-unique FK - see
--     jobs_estimate_id_unique in 20260918134457_add_jobs_table.sql, "one
--     job per estimate, ever")
-- No new column, no new table - only the `type` CHECK needs widening.
-- `source_entity_type` already permits 'estimate' (this type's source),
-- unchanged since the original opportunities migration.
--
-- One additive, idempotent, rerun-safe constraint change, using the exact
-- live constraint name (verified directly against the database before
-- writing this migration) - matching every prior opportunity-type-widening
-- migration's own established pattern exactly. No RLS/index/trigger
-- change - the existing opportunities_select/insert/update/delete
-- policies, the payment-gate restrictive policy, the partial unique dedup
-- index, and the updated_at trigger all already cover any type value,
-- since none of them enumerate specific types themselves.

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
    'cancelled_appointment_no_rebooking',
    'uncontacted_lead',
    'accepted_estimate_no_job'
  ));
