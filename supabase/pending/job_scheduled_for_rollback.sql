-- Rollback for job_scheduled_for.sql. Deploy code that no longer reads
-- jobs.scheduled_for BEFORE running this - it drops the recorded dates.
-- Idempotent.
alter table public.jobs drop column if exists scheduled_for;
