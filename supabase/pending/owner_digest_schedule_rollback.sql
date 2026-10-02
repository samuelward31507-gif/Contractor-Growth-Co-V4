-- Rollback for owner_digest_schedule.sql. Run as one transaction, by a
-- person, only if the forward script must be undone.
--
-- ORDER MATTERS - always in this sequence:
--  1. Revert/redeploy the application code first, so owner-digest is no
--     longer in SCHEDULED_AUTOMATION_IDS (no longer an expected scheduled
--     automation).
--  2. Only then run this script.
-- Why: running this script while the Phase 3G-1 code is still deployed
-- removes owner-digest's schedule while the liveness catalog still expects
-- it. Its liveness turns stale after ~45 minutes, and /api/automation/health
-- (and the daily watchdog) would then raise the customer-facing "Automation
-- needs attention" alert to every live, paying organization's owners - a
-- false alarm. (The reverse order is harmless: with the old code deployed,
-- the still-scheduled job just gets a 404 with no side effects until this
-- script removes it.)
--
-- What it does:
--  1. Unschedules trackpr_owner_digest (if present).
--  2. Restores public.invoke_trackpr_scheduled to its exact Phase 3D body
--     (supabase/migrations/20261002102849_scheduler_version_control.sql:
--     eight paths, no owner-digest) with the same owner and the same revoked
--     EXECUTE grants.
-- The eight existing jobs and trackpr_cron_history_cleanup are not touched.

begin;

do $rollback$
begin
  if pg_catalog.to_regnamespace('cron') is not null
     and exists (select 1 from cron.job j where j.jobname = 'trackpr_owner_digest') then
    perform cron.unschedule('trackpr_owner_digest');
  end if;
end;
$rollback$;

create or replace function public.invoke_trackpr_scheduled(p_path text)
 returns bigint
 language plpgsql
 set search_path to ''
as $function$
declare
  v_base_url text;
  v_cron_secret text;
begin
  if p_path is null or p_path not in (
    '/api/automation/appointment-reminders',
    '/api/automation/estimate-followups',
    '/api/automation/lead-nurture',
    '/api/automation/lead-reactivation',
    '/api/automation/customer-reactivation',
    '/api/automation/no-show-detection',
    '/api/automation/health',
    '/api/automation/opportunity-sync'
  ) then
    raise exception 'invoke_trackpr_scheduled: unknown scheduler path';
  end if;

  select ds.decrypted_secret
    into v_base_url
    from vault.decrypted_secrets ds
   where ds.name = 'trackpr_base_url';

  select ds.decrypted_secret
    into v_cron_secret
    from vault.decrypted_secrets ds
   where ds.name = 'trackpr_cron_secret';

  if v_base_url is null or pg_catalog.btrim(v_base_url) = '' then
    raise exception 'invoke_trackpr_scheduled: Vault secret trackpr_base_url is missing or empty';
  end if;

  if v_cron_secret is null or pg_catalog.btrim(v_cron_secret) = '' then
    raise exception 'invoke_trackpr_scheduled: Vault secret trackpr_cron_secret is missing or empty';
  end if;

  v_base_url := pg_catalog.rtrim(pg_catalog.btrim(v_base_url), '/');

  -- An https origin only (scheme + host[:port], no path, query or fragment),
  -- so the route path below is always appended to a clean origin. The value
  -- itself is never included in the error.
  if v_base_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    raise exception 'invoke_trackpr_scheduled: Vault secret trackpr_base_url must be an https origin with no path';
  end if;

  return net.http_get(
    url := v_base_url || p_path,
    headers := pg_catalog.jsonb_build_object('Authorization', 'Bearer ' || v_cron_secret),
    timeout_milliseconds := 300000
  );
end;
$function$;

alter function public.invoke_trackpr_scheduled(text) owner to postgres;
revoke all on function public.invoke_trackpr_scheduled(text) from public;
revoke all on function public.invoke_trackpr_scheduled(text) from anon;
revoke all on function public.invoke_trackpr_scheduled(text) from authenticated;
revoke all on function public.invoke_trackpr_scheduled(text) from service_role;

commit;
