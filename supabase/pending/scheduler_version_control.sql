-- Phase 3D (Scheduler Reliability): bring the existing Supabase pg_cron
-- scheduler under version control, and schedule opportunity detection.
--
-- STATUS: PENDING - not applied anywhere. See supabase/pending/README.md for
-- the apply procedure (a person applies it; the file moves into
-- supabase/migrations/ only under the ledger version it produces).
--
-- WHY: Production's business scheduler is Supabase pg_cron + pg_net - seven
-- jobs that call Trackpr's scheduled routes every 15 minutes through
-- public.invoke_trackpr_scheduled - but none of it exists in this
-- repository. This script records it exactly as it runs today (captured
-- read-only on 2026-10-02: job names and schedules from cron.job, and the
-- helper's body from pg_get_functiondef - no secret was read or recorded),
-- and adds one job for scheduled opportunity detection.
--
-- WHAT:
--
-- 1. public.invoke_trackpr_scheduled(p_path text) - re-created byte-for-byte
--    from Production, with exactly one change: '/api/automation/opportunity-sync'
--    added to its route allowlist. Still plpgsql, SECURITY INVOKER (the
--    default), search_path pinned to '', both values read from Supabase
--    Vault by NAME (trackpr_base_url, trackpr_cron_secret), an https-origin
--    check, a GET with the Bearer header built from the Vault value, a
--    300000 ms timeout and no retries. No secret, URL or token appears in
--    this file. Owner stays postgres; EXECUTE is revoked from public, anon,
--    authenticated and service_role, matching Production (only the owner -
--    the role pg_cron runs these jobs as - can call it).
--
-- 2. The seven existing jobs, re-declared with their EXACT existing names,
--    schedules and commands, plus trackpr_opportunity_sync. cron.schedule
--    with an existing job name UPDATES that job rather than adding a
--    second one - but pg_cron matches names per database user, so the
--    script refuses to run if a same-named job belongs to a different user
--    (that would create a duplicate), and verifies afterwards that every
--    name maps to exactly one job. trackpr_cron_history_cleanup is not
--    touched (it stays inactive).
--
--    The job section only runs when pg_cron is installed and both Vault
--    secrets exist - otherwise it does nothing and says so. That keeps a
--    database without the scheduler (TEST, a fresh project) from getting
--    jobs that would fail every 15 minutes.
--
-- Not created here: the pg_cron / pg_net extensions (already enabled in
-- Production; no existing migration manages them) and the Vault secrets
-- (created per environment by a person - never in a migration).
--
-- Idempotent: safe to apply twice. Apply as ONE transaction (the MCP
-- apply_migration mechanism supplies it; in the SQL editor keep the
-- begin/commit below). Rollback: scheduler_version_control_rollback.sql.

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

do $scheduler$
declare
  v_jobs constant text[][] := array[
    ['trackpr_appointment_reminders', '0,15,30,45 * * * *', '/api/automation/appointment-reminders'],
    ['trackpr_estimate_followups', '1,16,31,46 * * * *', '/api/automation/estimate-followups'],
    ['trackpr_lead_nurture', '2,17,32,47 * * * *', '/api/automation/lead-nurture'],
    ['trackpr_lead_reactivation', '3,18,33,48 * * * *', '/api/automation/lead-reactivation'],
    ['trackpr_customer_reactivation', '4,19,34,49 * * * *', '/api/automation/customer-reactivation'],
    ['trackpr_no_show_detection', '5,20,35,50 * * * *', '/api/automation/no-show-detection'],
    ['trackpr_automation_health', '6,21,36,51 * * * *', '/api/automation/health'],
    ['trackpr_opportunity_sync', '7,22,37,52 * * * *', '/api/automation/opportunity-sync']
  ];
  v_i integer;
  v_count integer;
begin
  if pg_catalog.to_regnamespace('cron') is null then
    raise notice 'scheduler_version_control: pg_cron is not installed - no jobs created';
    return;
  end if;

  if pg_catalog.to_regclass('vault.secrets') is null
     or (select pg_catalog.count(*) from vault.secrets s where s.name in ('trackpr_base_url', 'trackpr_cron_secret')) < 2 then
    raise notice 'scheduler_version_control: Vault secrets trackpr_base_url / trackpr_cron_secret are not both present - no jobs created';
    return;
  end if;

  for v_i in 1 .. pg_catalog.array_length(v_jobs, 1) loop
    -- pg_cron matches job names per user: a same-named job owned by another
    -- role would be duplicated, not updated. Refuse instead.
    if exists (select 1 from cron.job j where j.jobname = v_jobs[v_i][1] and j.username <> current_user) then
      raise exception 'scheduler_version_control: job % exists under a different role - refusing to create a duplicate', v_jobs[v_i][1];
    end if;

    perform cron.schedule(
      v_jobs[v_i][1],
      v_jobs[v_i][2],
      pg_catalog.format('select public.invoke_trackpr_scheduled(%L)', v_jobs[v_i][3])
    );

    select pg_catalog.count(*) into v_count from cron.job j where j.jobname = v_jobs[v_i][1];
    if v_count <> 1 then
      raise exception 'scheduler_version_control: expected exactly one job named %, found %', v_jobs[v_i][1], v_count;
    end if;
  end loop;
end;
$scheduler$;

commit;
