-- Gym Foundation Phase 1, Section 7: smallest safe unblock for a future
-- gym review/referral trigger.
--
-- review_requests.job_id and referral_requests.job_id are both `not null`
-- (20260919150200_review_referral_tracking.sql) - today the entire
-- review/referral mechanism is structurally anchored to a completed
-- contractor job. A gym's natural trigger for asking for a review/referral
-- is not a "job" at all (e.g. a membership milestone or a check-in streak),
-- so a future gym review/referral workflow will need to create a row
-- without a job_id.
--
-- This migration does exactly one thing: makes job_id nullable. It does
-- NOT add a new alternate-anchor column (e.g. membership_id) - that would
-- be building ahead of an actual gym review/referral automation, which
-- Phase 1 explicitly defers. Every existing row already has a non-null
-- job_id, so this is a no-op for current data, and no application code in
-- this codebase ever sends a null job_id today (the only writer is the
-- post-job-followup automation, which only ever runs for a completed job),
-- so contractor behavior is unchanged. A future phase that actually builds
-- gym review/referral automation will add whatever alternate anchor column
-- it needs then, informed by the real workflow it's building.

alter table public.review_requests
  alter column job_id drop not null;

alter table public.referral_requests
  alter column job_id drop not null;
