-- Rollback for organization_health_inputs.sql. Run as one transaction, by a
-- person, only if the forward script must be undone.
--
-- ORDER MATTERS: revert the application code first (the rpc() call in
-- lib/automation-health/health.ts's computeOrganizationHealth). While that
-- code is deployed, a missing organization_health_inputs function makes the
-- health read fail, and the summary then fails closed (payment_blocked, zero
-- counts) - the same result every one of the old six reads produced on its
-- own failure - on every page that shows health. Once the code is reverted
-- the function is unused, so leaving it in place is also safe.
--
-- Read-only function: dropping it loses no data.

drop function if exists public.organization_health_inputs(uuid, timestamptz, timestamptz);
