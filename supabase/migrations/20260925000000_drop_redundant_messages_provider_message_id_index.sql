-- S4 (pre-launch lead-leak audit): drops a purely redundant duplicate index.
--
-- messages.provider_message_id currently has TWO functionally identical
-- unique partial indexes: messages_provider_message_id_key (created in
-- 20260918043430_communication_layer_foundation.sql) and
-- messages_provider_message_id_unique (created later, in
-- 20260919170000_messages_provider_message_id_unique.sql, apparently
-- without realizing the first one already existed). Confirmed via
-- pg_indexes that both have the exact same definition:
--   CREATE UNIQUE INDEX ... ON public.messages USING btree
--   (provider_message_id) WHERE (provider_message_id IS NOT NULL)
-- Confirmed via a repo-wide search that no RPC, migration, or application
-- code references either index by name (e.g. no `ON CONFLICT ON CONSTRAINT
-- messages_provider_message_id_unique`), so dropping the later, truly
-- redundant one is safe: it changes no query plan option that the first
-- index doesn't already provide, and removes no constraint any other object
-- depends on. The original messages_provider_message_id_key is kept
-- untouched, along with every other index/constraint on this table.

drop index if exists public.messages_provider_message_id_unique;
