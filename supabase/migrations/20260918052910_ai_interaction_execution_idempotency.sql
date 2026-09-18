-- Phase 4: Instant Lead Response + AI Qualification - idempotency
-- strengthening only. No new tables. Qualification output itself needs no
-- schema change: ai_interactions.output is already a generic jsonb column
-- that stores whatever structured result the n8n callback receives, and
-- leads.ai_summary already exists specifically for a short AI-derived
-- rollup - both are written to directly by application code, not by this
-- migration.
--
-- The one real gap: two genuinely concurrent callback deliveries for the
-- same workflow_execution (a true race, not a simple retry - a retry after
-- completion is already caught by the execution.status !== 'running' check
-- in the callback route) could each pass that check before either finishes,
-- and each would insert its own ai_interactions row. complete_workflow_execution's
-- atomic `UPDATE ... WHERE status = 'running'` guard (already in place)
-- ensures only one of them completes the execution, but nothing previously
-- stopped both from writing a duplicate AI interaction first. Tying
-- ai_interactions to the exact execution it came from, with a unique
-- index, closes that.

alter table public.ai_interactions
  add column workflow_execution_id uuid references public.workflow_executions(id) on delete set null;

create unique index ai_interactions_workflow_execution_id_key
  on public.ai_interactions (workflow_execution_id)
  where workflow_execution_id is not null;
