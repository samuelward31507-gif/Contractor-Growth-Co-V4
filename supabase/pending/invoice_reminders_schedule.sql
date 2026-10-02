-- Phase 3G-2b (Invoice Reminders): schedule the invoice reminders route on
-- the existing Supabase pg_cron scheduler.
--
-- STATUS: PENDING - not applied anywhere. See supabase/pending/README.md for
-- the apply procedure (a person applies it after the application code is
-- deployed; the file moves into supabase/migrations/ only under the ledger
-- version it produces).
--
-- WHAT:
--
-- 1. public.invoke_trackpr_scheduled(p_path text) - re-created from
--    supabase/migrations/20261002150020_owner_digest_schedule.sql with
--    exactly one change: '/api/automation/invoice-reminders' added to its
--    route allowlist. Same plpgsql, SECURITY INVOKER, search_path '', Vault
--    names (trackpr_base_url, trackpr_cron_secret), https-origin check, GET
--    with the Vault-built Bearer header, 300000 ms timeout, no retries. No
--    secret, URL or token appears in this file. Owner stays postgres;
--    EXECUTE stays revoked from public, anon, authenticated and
--    service_role.
--
-- 2. One new job, trackpr_invoice_reminders, at 9,24,39,54 * * * * (the
--    first unused minute after the nine existing jobs at minutes 0-8). The
--    route decides what is due (organizations that turned Invoice Reminders
--    on, 9:00-18:00 local, invoices 1-20 days past due). The existing jobs
--    and trackpr_cron_history_cleanup are not touched. The same guards as
--    the 3D/3G-1 scripts: refuse a same-named job owned by another role,
--    verify exactly one job by name, and do nothing without pg_cron or both
--    Vault secrets (TEST, a fresh project).
--
-- Idempotent: safe to apply twice. Apply as ONE transaction. Rollback:
-- invoice_reminders_schedule_rollback.sql (revert the application code
-- FIRST - see the README's rollback order).

begin;

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
    '/api/automation/opportunity-sync',
    '/api/automation/owner-digest',
    '/api/automation/invoice-reminders'
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

do $scheduler$
declare
  v_name constant text := 'trackpr_invoice_reminders';
  v_schedule constant text := '9,24,39,54 * * * *';
  v_path constant text := '/api/automation/invoice-reminders';
  v_count integer;
begin
  if pg_catalog.to_regnamespace('cron') is null then
    raise notice 'invoice_reminders_schedule: pg_cron is not installed - no job created';
    return;
  end if;

  if pg_catalog.to_regclass('vault.secrets') is null
     or (select pg_catalog.count(*) from vault.secrets s where s.name in ('trackpr_base_url', 'trackpr_cron_secret')) < 2 then
    raise notice 'invoice_reminders_schedule: Vault secrets trackpr_base_url / trackpr_cron_secret are not both present - no job created';
    return;
  end if;

  -- pg_cron matches job names per user: a same-named job owned by another
  -- role would be duplicated, not updated. Refuse instead.
  if exists (select 1 from cron.job j where j.jobname = v_name and j.username <> current_user) then
    raise exception 'invoice_reminders_schedule: job % exists under a different role - refusing to create a duplicate', v_name;
  end if;

  perform cron.schedule(v_name, v_schedule, pg_catalog.format('select public.invoke_trackpr_scheduled(%L)', v_path));

  select pg_catalog.count(*) into v_count from cron.job j where j.jobname = v_name;
  if v_count <> 1 then
    raise exception 'invoice_reminders_schedule: expected exactly one job named %, found %', v_name, v_count;
  end if;
end;
$scheduler$;

commit;
