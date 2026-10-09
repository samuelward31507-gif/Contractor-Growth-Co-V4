-- Rollback for agency_client_handoff.sql - NON-DESTRUCTIVE.
--
-- Removes the three write paths (prepare, confirm, cancel) and the missing-
-- fields helper, so no new handoff can be prepared or confirmed and no
-- client created. The previous application build never reads these tables,
-- so it works unchanged afterwards.
--
-- It KEEPS: both tables with every row (handoffs prepared, confirmed or
-- cancelled, and every Agency client created), their RLS policies, their
-- select-only grants, and the snapshot guard (so a kept handoff still can't
-- be rewritten). Founder deals and their activity history are untouched -
-- this feature never wrote to them.
--
-- Idempotent. Re-applying agency_client_handoff.sql restores the functions.

begin;

drop function if exists public.founder_prepare_client_handoff(uuid, uuid, text);
drop function if exists public.agency_confirm_client_handoff(uuid);
drop function if exists public.cancel_client_handoff(uuid, text);
drop function if exists public.founder_handoff_missing(public.founder_deals, text);

commit;

-- NOT RUN BY DEFAULT - permanently deletes every handoff and Agency client
-- record; needs explicit authorization:
--   drop table public.agency_client_handoffs cascade;
--   drop table public.agency_clients cascade;
--   drop function public.agency_client_handoffs_snapshot_guard();
