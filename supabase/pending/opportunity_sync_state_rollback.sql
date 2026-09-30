-- Rollback for opportunity_sync_state.sql. Run as one transaction, by a
-- person, only if the forward script must be undone.
--
-- ORDER MATTERS: revert the application code first (the claim call in
-- lib/opportunities/background-sync.ts). While that code is deployed, a
-- missing claim_opportunity_sync function makes every claim fail, and a
-- failed claim skips the sync - opportunities would stop refreshing
-- entirely. Once the code is reverted, the sync runs unthrottled exactly as
-- before and this table and function are inert, so leaving them in place is
-- also safe.
--
-- Nothing is lost by dropping the table: it only records when each
-- organization's last sync was claimed.

drop function if exists public.claim_opportunity_sync(uuid);
drop table if exists public.opportunity_sync_state;
