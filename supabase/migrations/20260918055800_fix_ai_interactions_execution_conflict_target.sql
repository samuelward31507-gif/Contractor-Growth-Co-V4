-- Fixes a bug found during Phase 4 testing: the previous migration's unique
-- index on ai_interactions.workflow_execution_id was partial
-- (where workflow_execution_id is not null). Postgres's ON CONFLICT
-- inference requires the conflict target to exactly match an existing
-- constraint, including any predicate - a plain
-- `ON CONFLICT (workflow_execution_id)` (what Supabase's
-- `.upsert(..., { onConflict: 'workflow_execution_id' })` sends) does not
-- match a partial index, so every upsert failed with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification" (silently
-- logged server-side, never surfacing to the n8n caller).
--
-- The partial predicate was never actually needed: a plain (non-partial)
-- unique index on a nullable column already permits unlimited NULLs in
-- Postgres, since NULL is never considered equal to NULL for uniqueness -
-- exactly the "many rows with no execution, at most one row per real
-- execution" behavior this column needs.

drop index if exists public.ai_interactions_workflow_execution_id_key;

create unique index ai_interactions_workflow_execution_id_key
  on public.ai_interactions (workflow_execution_id);
