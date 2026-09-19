-- Automation Health + Alerting V1 - auto-resolution RPCs.
--
-- automation_incidents intentionally has no UPDATE policy for
-- `authenticated` (see the automation_health_and_alerting migration's own
-- comment: every write goes through a narrow SECURITY DEFINER RPC). Several
-- of the call sites that need to auto-resolve a failure incident on a
-- subsequent success run with a real user's SESSION client, not
-- service-role - e.g. lib/automation/lead-followup.ts's after() callback,
-- which reuses the original authenticated request's client. A plain
-- `.update()` from that client would silently affect zero rows under RLS
-- rather than erroring, which would make auto-resolution quietly stop
-- working for those paths - so, like every other write to this table, it
-- goes through a dedicated SECURITY DEFINER RPC instead.

create or replace function public.resolve_automation_incidents_by_fingerprint(
  p_organization_id uuid,
  p_fingerprints text[]
)
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_is_service_role boolean;
  v_count integer;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if p_organization_id is null then
    raise exception 'organization_id is required';
  end if;

  if not v_is_service_role then
    if auth.uid() is null then
      raise exception 'Not authenticated';
    end if;
    if not public.is_org_member(p_organization_id) then
      raise exception 'Not authorized';
    end if;
  end if;

  if p_fingerprints is null or array_length(p_fingerprints, 1) is null then
    return 0;
  end if;

  update public.automation_incidents
  set status = 'resolved', resolved_at = now(), updated_at = now()
  where organization_id = p_organization_id
    and fingerprint = any(p_fingerprints)
    and status in ('open', 'acknowledged');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.resolve_automation_incidents_by_fingerprint(uuid, text[]) from public;
revoke all on function public.resolve_automation_incidents_by_fingerprint(uuid, text[]) from anon;
grant execute on function public.resolve_automation_incidents_by_fingerprint(uuid, text[]) to authenticated, service_role;

-- Stuck-execution incident auto-resolution - service_role only. This is
-- only ever invoked from app/api/automation/health (the CRON_SECRET-
-- protected, service-role-authenticated stuck-execution scan), which spans
-- every organization in one pass, so it is intentionally not
-- organization-scoped or is_org_member-checked like the RPC above - there is
-- no session in this context to check membership against. Resolves exactly
-- the active workflow_stuck incidents whose linked execution has left the
-- 'running' state since the incident was opened (completed, failed, or
-- cancelled) - bounded by LIMIT, joined on the existing indexed
-- workflow_execution_id/status columns, never a full table scan.
create or replace function public.resolve_stale_stuck_incidents()
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Not authorized';
  end if;

  with stale as (
    select ai.id
    from public.automation_incidents ai
    join public.workflow_executions we on we.id = ai.workflow_execution_id
    where ai.category = 'workflow_stuck'
      and ai.status in ('open', 'acknowledged')
      and we.status <> 'running'
    limit 500
  )
  update public.automation_incidents
  set status = 'resolved', resolved_at = now(), updated_at = now()
  where id in (select id from stale);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.resolve_stale_stuck_incidents() from public;
revoke all on function public.resolve_stale_stuck_incidents() from anon;
revoke all on function public.resolve_stale_stuck_incidents() from authenticated;
grant execute on function public.resolve_stale_stuck_incidents() to service_role;
