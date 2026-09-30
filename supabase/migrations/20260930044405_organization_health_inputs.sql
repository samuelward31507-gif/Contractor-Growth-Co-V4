-- Performance Pass 3 (Dashboard automation-health consolidation): one
-- read-only function returning every input lib/automation-health/health.ts's
-- computeOrganizationHealth() needs, replacing the six PostgREST requests it
-- made on every call.
--
-- STATUS: PENDING - not applied anywhere. See supabase/pending/README.md for
-- the apply procedure (a person applies it; the file moves into
-- supabase/migrations/ only under the ledger version it produces).
--
-- WHY: the Dashboard's server render fires ~23 simultaneous PostgREST
-- requests against a pool of about ten database connections, so requests
-- queue; six of them were this health summary (also run by the top bar on
-- every full (app) page load). One request instead of six shrinks that burst
-- on every page that shows health. The function returns exactly the inputs
-- the summary uses - health.ts's own TypeScript still does every
-- calculation, unchanged - and nothing it does not use (the old
-- getAutomationOverview() also read automation_events, which the health
-- summary never used; this function does not read it at all).
--
-- WHAT IT RETURNS (jsonb), each mirroring one of the six old reads exactly:
--   window_status_counts  {completed, failed} over workflow_executions whose
--                         started_at is in [p_executions_from,
--                         p_executions_to), capped at 10,000 rows exactly
--                         like lib/bi/queries.ts's getAutomationAndFollowUp-
--                         Metrics (unordered, MAX_ROWS = 10_000). The window
--                         is passed in by the caller, computed by the same
--                         resolveDateRange("last30Days") as before, so the
--                         bounds are byte-identical (no timezone logic here).
--   name_stats            per workflow_name over the newest 500 executions
--                         (lib/automation/queries.ts's getWorkflowNameStats:
--                         order by started_at desc limit 500): the latest
--                         execution's status and started_at, and the failed
--                         count - the only fields the health summary reads.
--   incidents             category and severity of the newest 200 open or
--                         acknowledged incidents (lib/automation-health/
--                         queries.ts's listIncidents: order by updated_at
--                         desc limit 200) - the only fields the summary reads.
--   organization          {payment_status, automation_paused}, or null when
--                         the caller cannot see the row (the summary then
--                         fails closed to payment_required, as before).
--   liveness              get_scheduled_automation_liveness()'s rows,
--                         unchanged (the platform-level scheduled-automation
--                         summary; still its own SECURITY DEFINER function).
--
-- SECURITY: the dashboard_* functions' convention exactly - STABLE,
-- read-only, SECURITY INVOKER (every read runs under the caller's own RLS,
-- the same policies the six PostgREST reads ran under: a non-member or an
-- unpaid organization sees exactly what it saw before), fixed search_path,
-- explicit organization_id filters, EXECUTE revoked from PUBLIC/anon and
-- granted to authenticated. No tables, indexes, policies or other objects.
--
-- Idempotent (create or replace). Rollback:
-- organization_health_inputs_rollback.sql - revert the application code
-- first (see the README).

create or replace function public.organization_health_inputs(
  p_organization_id uuid,
  p_executions_from timestamptz,
  p_executions_to timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'window_status_counts', (
      select jsonb_build_object(
        'completed', count(*) filter (where w.status = 'completed'),
        'failed', count(*) filter (where w.status = 'failed')
      )
      from (
        select we.status
        from public.workflow_executions we
        where we.organization_id = p_organization_id
          and (p_executions_from is null or we.started_at >= p_executions_from)
          and (p_executions_to is null or we.started_at < p_executions_to)
        limit 10000
      ) w
    ),
    'name_stats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'workflow_name', n.workflow_name,
        'last_status', n.last_status,
        'last_execution_at', n.last_execution_at,
        'failed', n.failed
      ) order by n.workflow_name)
      from (
        select
          r.workflow_name,
          (array_agg(r.status order by r.position))[1] as last_status,
          (array_agg(r.started_at order by r.position))[1] as last_execution_at,
          count(*) filter (where r.status = 'failed') as failed
        from (
          select we.workflow_name, we.status, we.started_at,
                 row_number() over (order by we.started_at desc) as position
          from public.workflow_executions we
          where we.organization_id = p_organization_id
          order by we.started_at desc
          limit 500
        ) r
        group by r.workflow_name
      ) n
    ), '[]'::jsonb),
    'incidents', coalesce((
      select jsonb_agg(jsonb_build_object('category', i.category, 'severity', i.severity))
      from (
        select ai.category, ai.severity
        from public.automation_incidents ai
        where ai.organization_id = p_organization_id
          and ai.status in ('open', 'acknowledged')
        order by ai.updated_at desc
        limit 200
      ) i
    ), '[]'::jsonb),
    'organization', (
      select jsonb_build_object('payment_status', o.payment_status, 'automation_paused', o.automation_paused)
      from public.organizations o
      where o.id = p_organization_id
    ),
    'liveness', coalesce((
      select jsonb_agg(jsonb_build_object(
        'automation_id', l.automation_id,
        'last_ran_at', l.last_ran_at,
        'last_candidate_count', l.last_candidate_count
      ))
      from public.get_scheduled_automation_liveness() l
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.organization_health_inputs(uuid, timestamptz, timestamptz) from public;
revoke all on function public.organization_health_inputs(uuid, timestamptz, timestamptz) from anon;
grant execute on function public.organization_health_inputs(uuid, timestamptz, timestamptz) to authenticated;
