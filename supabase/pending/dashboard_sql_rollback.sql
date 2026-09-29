-- Rollback for dashboard_sql.sql. Run as one transaction, by a person, only
-- if the forward script must be undone. Deploy the application code that no
-- longer calls these functions FIRST (the pre-Phase-2D Dashboard), then run
-- this. The functions are read-only and own no data, so dropping them loses
-- nothing.

begin;

drop function if exists public.dashboard_briefing(uuid, timestamptz, timestamptz, timestamptz);
drop function if exists public.dashboard_conversation_attention(uuid, timestamptz);
drop function if exists public.dashboard_summary(uuid, timestamptz, timestamptz, timestamptz);

commit;
