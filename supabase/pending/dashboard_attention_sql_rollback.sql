-- Rollback for dashboard_attention_sql.sql. Run as one transaction, by a
-- person, only if the forward script must be undone. Deploy the application
-- code that no longer calls this function FIRST (the Phase 2D Dashboard,
-- whose getDashboardData reads leads/appointments/estimates directly), then
-- run this. The function is read-only and owns no data.

begin;

drop function if exists public.dashboard_record_attention(uuid, timestamptz, numeric);

commit;
