-- Authorize an existing account as Agency Admin.
--
-- Uses the exact mechanism this codebase already established for this
-- purpose (see 20260918182032_agency_command_center_foundation.sql's own
-- comment: granting agency-admin status is an intentional out-of-band
-- operation via direct database access - never a self-service or in-app
-- action). This inserts exactly one row, targeting exactly one existing
-- auth.users id, into the existing agency_admins table. No schema change,
-- no RLS change, no new table, no change to any organization_members row,
-- and no change to any other account's authorization. Idempotent: reapplying
-- this migration is a no-op (agency_admins.user_id is already unique).

insert into public.agency_admins (user_id)
values ('861e5ea8-12c5-42e1-82d9-2f6aeec39178')
on conflict (user_id) do nothing;
