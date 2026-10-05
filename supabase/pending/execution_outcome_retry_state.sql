-- P0 A2: durable execution outcome + retry lifecycle on workflow_executions.
--
-- STATUS: PENDING for Production - applied to TEST only. See
-- supabase/pending/README.md for the apply procedure.
--
-- WHY: an execution today ends as status 'completed' or 'failed' only. A
-- legitimate safety block is a 'completed' row with metadata.blocked_reason
-- (indistinguishable from success without parsing JSON), a stale timeout is
-- a 'failed' row with an execution_timeout: error, and nothing records
-- whether Trackpr will retry a failure, when, or that it has stopped. A2
-- needs each of those as a durable, queryable fact.
--
-- WHAT (additive only - no existing column, RPC, policy or grant changes):
--
-- 1. outcome      - derived by trigger from the existing status /
--                   metadata.blocked_reason / error_message, so every
--                   existing RPC (complete/fail/start_workflow_execution)
--                   keeps working unchanged and the value can never drift
--                   from the status it describes:
--                     running   -> null
--                     completed -> 'blocked' when metadata.blocked_reason is
--                                  set, else 'succeeded'
--                     failed    -> 'timed_out' for an execution_timeout:
--                                  error, else 'failed'
--                     cancelled -> 'cancelled'
-- 2. retry_state  - Trackpr's decision about a FAILED execution, written by
--                   the service-role health tick (lib/automation/
--                   execution-retry.ts): 'scheduled' (next_retry_at set),
--                   'retried' (a new attempt was started), 'exhausted'
--                   (max attempts reached - permanent), 'not_retryable'
--                   (the workflow is not safely retryable - permanent).
--                   null = not yet decided (or not failed).
-- 3. next_retry_at, max_attempts, retry_detail - when, the policy ceiling,
--                   and the human-readable reason for the decision.
-- 4. Two partial indexes: due retries, and still-running executions (the
--    stale scan). Undecided failures reuse idx_workflow_executions_status.
-- 5. Backfill: existing rows get their derived outcome; existing failures
--    are marked retry_state 'not_retryable' / 'pre_a2_failure' so the new
--    automatic retry never picks up historical failures.
--
-- Idempotent: safe to apply twice. Rollback:
-- execution_outcome_retry_state_rollback.sql.

alter table public.workflow_executions
  add column if not exists outcome text,
  add column if not exists retry_state text,
  add column if not exists next_retry_at timestamptz,
  add column if not exists max_attempts integer,
  add column if not exists retry_detail text;

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conname = 'workflow_executions_outcome_check') then
    alter table public.workflow_executions add constraint workflow_executions_outcome_check
      check (outcome is null or outcome in ('succeeded', 'blocked', 'failed', 'timed_out', 'cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflow_executions_retry_state_check') then
    alter table public.workflow_executions add constraint workflow_executions_retry_state_check
      check (retry_state is null or (status = 'failed' and retry_state in ('scheduled', 'retried', 'exhausted', 'not_retryable')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflow_executions_retry_schedule_check') then
    alter table public.workflow_executions add constraint workflow_executions_retry_schedule_check
      check (retry_state is distinct from 'scheduled' or next_retry_at is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflow_executions_max_attempts_check') then
    alter table public.workflow_executions add constraint workflow_executions_max_attempts_check
      check (max_attempts is null or max_attempts between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflow_executions_retry_detail_check') then
    alter table public.workflow_executions add constraint workflow_executions_retry_detail_check
      check (retry_detail is null or char_length(retry_detail) <= 500);
  end if;
end
$constraints$;

create or replace function public.workflow_executions_derive_outcome()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.outcome := case new.status
    when 'running' then null
    when 'completed' then case when nullif(pg_catalog.jsonb_extract_path_text(new.metadata, 'blocked_reason'), '') is not null then 'blocked' else 'succeeded' end
    when 'failed' then case when pg_catalog.starts_with(coalesce(new.error_message, ''), 'execution_timeout:') then 'timed_out' else 'failed' end
    when 'cancelled' then 'cancelled'
    else null
  end;
  return new;
end;
$function$;

create or replace trigger workflow_executions_derive_outcome
  before insert or update of status, metadata, error_message on public.workflow_executions
  for each row execute function public.workflow_executions_derive_outcome();

create index if not exists idx_workflow_executions_retry_due
  on public.workflow_executions (next_retry_at)
  where retry_state = 'scheduled';

create index if not exists idx_workflow_executions_running_started
  on public.workflow_executions (started_at)
  where status = 'running';

-- Backfill: derived outcome for every existing row; historical failures are
-- never auto-retried.
update public.workflow_executions
   set outcome = case status
         when 'completed' then case when nullif(pg_catalog.jsonb_extract_path_text(metadata, 'blocked_reason'), '') is not null then 'blocked' else 'succeeded' end
         when 'failed' then case when pg_catalog.starts_with(coalesce(error_message, ''), 'execution_timeout:') then 'timed_out' else 'failed' end
         when 'cancelled' then 'cancelled'
         else null
       end
 where outcome is distinct from (case status
         when 'completed' then case when nullif(pg_catalog.jsonb_extract_path_text(metadata, 'blocked_reason'), '') is not null then 'blocked' else 'succeeded' end
         when 'failed' then case when pg_catalog.starts_with(coalesce(error_message, ''), 'execution_timeout:') then 'timed_out' else 'failed' end
         when 'cancelled' then 'cancelled'
         else null
       end);

update public.workflow_executions
   set retry_state = 'not_retryable', retry_detail = 'pre_a2_failure'
 where status = 'failed' and retry_state is null;
