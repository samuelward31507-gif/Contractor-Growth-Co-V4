-- Pass 5A: System Truth + Automation Reliability.
--
-- WHY THIS TABLE: today, a scheduled automation's own success is only ever
-- recorded per-CANDIDATE, via workflow_executions/automation_events - when a
-- scheduled route (appointment-reminders, estimate-followups, lead-nurture,
-- lead-reactivation, customer-reactivation - see lib/automation/cron-auth.ts)
-- finds zero eligible candidates on a given tick, it writes NOTHING at all.
-- Zero eligible candidates is a common, healthy outcome for a lightly-loaded
-- organization, so "this route hasn't been called by the n8n Schedule
-- Trigger in days" and "this route runs constantly but nobody currently
-- qualifies" were completely indistinguishable - there was no evidence
-- either way. This table closes that gap the same way
-- automation_health_check_runs already does for the health-check route
-- itself: one row per invocation, regardless of outcome.
--
-- Deliberately NOT organization-scoped: one invocation of any of these
-- routes processes every organization in a single pass, so "did the route
-- run" is inherently a global fact, not a per-organization one - mirrors
-- automation_health_check_runs' own established precedent exactly.
--
-- SECURITY (Pass 5 audit follow-up): automation_health_check_runs grants
-- plain SELECT to any authenticated user platform-wide (a real, if
-- low-severity, finding from the Pass 5 audit - no organization_id exists on
-- that table, so nothing scopes that read). This table is built more
-- narrowly from the start: no SELECT grant to authenticated/anon at all.
-- Read access is instead funneled through get_scheduled_automation_liveness()
-- below, a narrow function returning only the derived per-automation summary
-- (latest run per automation_id), never raw historical rows.

create table public.automation_schedule_runs (
  id uuid primary key default gen_random_uuid(),
  -- Catalog id (lib/automation/catalog.ts) - not a foreign key, matching
  -- automation_incidents.automation_id's own established precedent (the
  -- catalog is a static TS list, not a database table).
  automation_id text not null,
  ran_at timestamp with time zone not null default now(),
  candidate_count integer not null check (candidate_count >= 0)
);

create index idx_automation_schedule_runs_automation_ran_at
  on public.automation_schedule_runs (automation_id, ran_at desc);

alter table public.automation_schedule_runs enable row level security;

-- No SELECT/INSERT policy for authenticated/anon at all - every write comes
-- from a scheduled route's own service-role client (exactly like
-- automation_health_check_runs), and every read goes through the RPC below.
grant select, insert, references, trigger on public.automation_schedule_runs to service_role;

-- ---------------------------------------------------------------------------
-- get_scheduled_automation_liveness: the one controlled read path onto
-- automation_schedule_runs. Returns exactly one row per automation_id - its
-- most recent invocation - never the full history. A plain SQL function
-- (not PLPGSQL): permission enforcement here is entirely the GRANT/REVOKE
-- below, not a runtime auth check, since the returned data is genuinely
-- global and non-sensitive (an automation id, a timestamp, a count - no
-- organization_id, no PII) once gated to authenticated sessions only.
create or replace function public.get_scheduled_automation_liveness()
returns table (automation_id text, last_ran_at timestamp with time zone, last_candidate_count integer)
language sql
security definer
set search_path = 'public'
stable
as $$
  select distinct on (automation_id) automation_id, ran_at, candidate_count
  from public.automation_schedule_runs
  order by automation_id, ran_at desc;
$$;

revoke all on function public.get_scheduled_automation_liveness() from public;
revoke all on function public.get_scheduled_automation_liveness() from anon;
grant execute on function public.get_scheduled_automation_liveness() to authenticated, service_role;
