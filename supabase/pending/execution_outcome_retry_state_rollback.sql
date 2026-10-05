-- Rollback for execution_outcome_retry_state.sql (P0 A2). Drops only what the
-- forward script added; existing columns, RPCs, policies and grants were
-- never changed. Retry decisions recorded in these columns are lost.
drop trigger if exists workflow_executions_derive_outcome on public.workflow_executions;
drop function if exists public.workflow_executions_derive_outcome();
drop index if exists public.idx_workflow_executions_retry_due;
drop index if exists public.idx_workflow_executions_running_started;
alter table public.workflow_executions
  drop constraint if exists workflow_executions_outcome_check,
  drop constraint if exists workflow_executions_retry_state_check,
  drop constraint if exists workflow_executions_retry_schedule_check,
  drop constraint if exists workflow_executions_max_attempts_check,
  drop constraint if exists workflow_executions_retry_detail_check,
  drop column if exists outcome,
  drop column if exists retry_state,
  drop column if exists next_retry_at,
  drop column if exists max_attempts,
  drop column if exists retry_detail;
