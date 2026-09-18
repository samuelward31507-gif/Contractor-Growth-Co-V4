-- Phase 4.3: Safe AI Outbound Response.
--
-- sendOutboundMessage() inserts the messages row BEFORE calling the SMS
-- provider, then updates it to sent/failed afterward. Two concurrent calls
-- for the exact same workflow_execution_id (a replayed n8n callback, a
-- duplicated HTTP request, or a genuine race between two callback
-- deliveries) could otherwise both pass every application-level check
-- before either has inserted its row, and both go on to insert a message
-- and call the SMS provider - a real double-send, not merely a duplicate
-- database row. Now that Phase 4.3 makes this path reachable in production
-- (should_send can actually be true), that race must be closed atomically,
-- not just discouraged by application logic.
--
-- This partial unique index is the actual guarantee: it makes a second
-- concurrent INSERT for the same workflow_execution_id fail at the database
-- level (23505 unique_violation), which sendOutboundMessage() now handles
-- explicitly - reporting the winning call's outcome instead of erroring or
-- attempting a second provider call. The safe outbound gate's own
-- pre-insert duplicate check remains as a fast path that avoids the
-- provider call entirely in the common (non-racing) case; this index is
-- what makes that guarantee hold even when two requests race.
--
-- Scoped to WHERE direction = 'outbound' AND workflow_execution_id IS NOT
-- NULL only - inbound messages, and any outbound message not tied to an
-- automation run (e.g. a future in-app compose action), are unaffected and
-- may still have a null workflow_execution_id with no uniqueness
-- constraint at all. No table is duplicated, no RLS policy is touched, no
-- existing column changes meaning.

create unique index if not exists messages_outbound_workflow_execution_unique
  on public.messages (workflow_execution_id)
  where direction = 'outbound' and workflow_execution_id is not null;
