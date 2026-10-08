-- Job scheduling state: when the work is actually scheduled with the customer.
--
-- STATUS: PENDING - not applied anywhere. Must be applied BEFORE the code
-- that reads it is deployed (lib/jobs/queries.ts selects this column for
-- every job read; a database without it fails those reads). See
-- supabase/pending/README.md.
--
-- WHY a column: an accepted estimate creates its job immediately, and
-- jobs.status = 'scheduled' only means the job has not started - it was
-- never a booking (a directly created job starts 'scheduled' too).
-- Appointments carry no job_id, so nothing in the schema records whether the
-- work has been booked with the customer. Today's "Customer approved -
-- schedule the work" item and the person's next step read this column.
--
-- SEMANTICS (jobs.status is unchanged):
--   status        - the job's lifecycle state (scheduled = not started).
--   scheduled_for - the instant the contractor scheduled the work for, set
--                   from the job page as a date and time in the
--                   organization's timezone (stored as an instant, like
--                   appointments.start_at). null = not scheduled yet.
--
-- No default and no backfill: existing jobs stay null - a date is never
-- guessed. RLS is unchanged (jobs_select / jobs_update and the payment-gate
-- policies already cover every column of the row). Idempotent.
-- Rollback: job_scheduled_for_rollback.sql.

alter table public.jobs add column if not exists scheduled_for timestamp with time zone;

comment on column public.jobs.scheduled_for is
  'When the work is scheduled with the customer (set by the contractor on the job page; an instant entered in the organization''s timezone). null = not scheduled yet. Independent of jobs.status, where scheduled means not started.';
