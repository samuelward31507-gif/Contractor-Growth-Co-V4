-- Rollback for followups.sql (P0 A4). Run by a person (contains DROP).
-- Every follow-up record is lost; workflow_executions/automation_events
-- written by follow-up touches are untouched.
drop table if exists public.followups;
