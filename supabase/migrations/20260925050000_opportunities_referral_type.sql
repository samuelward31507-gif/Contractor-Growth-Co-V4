-- Pass 4 (Customer Lifetime + Repeat Business Engine), P1-D: adds the one
-- new opportunity type the Pass 4 read-only audit judged safe to promote -
-- completed_job_no_referral_request. Unlike completed_job_no_review_request
-- (still deferred - a missing row is ambiguous between "not sent yet" and
-- "this org has no review_url configured"), referral_requests is written
-- unconditionally by the post-job-followup automation whenever it actually
-- runs (lib/reviews-referrals/tracking.ts's own recordPostJobFollowupOutcome:
-- "The referral request is always written - the automation always includes
-- a referral ask"), so the only remaining ambiguity is ordinary processing
-- timing, not a structural org-configuration gap.
--
-- Two small, additive CHECK-constraint changes only - no new table, no new
-- column, no RLS/index/trigger change (the existing opportunities_select/
-- insert/update/delete policies, the payment-gate restrictive policy, the
-- partial unique dedup index, and the updated_at trigger all already cover
-- every type/source_entity_type value, including these two new ones, since
-- none of them enumerate specific values themselves).
--
-- source_entity_type gains 'job' - the first opportunity type whose real
-- source is a jobs row rather than a lead/estimate/appointment/contact.
-- type gains 'completed_job_no_referral_request'.
--
-- Both constraints are dropped and recreated (Postgres has no ALTER CHECK),
-- using their exact live names (verified directly against the database
-- before writing this migration, not assumed) so this is a rerun-safe,
-- idempotent widening - never a narrowing, so no existing row can ever
-- violate the new constraint.

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
    'completed_job_no_referral_request'
  ));

alter table public.opportunities
  drop constraint if exists opportunities_source_entity_type_check;

alter table public.opportunities
  add constraint opportunities_source_entity_type_check
  check (source_entity_type in ('lead', 'estimate', 'appointment', 'contact', 'job'));
