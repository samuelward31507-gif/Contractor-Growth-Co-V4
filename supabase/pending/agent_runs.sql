-- Agent Operating Layer, Phase 1: run history for Trackpr's internal agents.
--
-- PENDING - not applied to production. Apply deliberately (see
-- supabase/pending/README.md, "agent_runs.sql"), read back the ledger
-- version, then move this file into supabase/migrations/.
--
-- Additive only: one new table, two indexes, two policies, grants. Touches
-- no existing table, function, policy or trigger.
--
-- One row per agent per run; every row of one Chief of Staff briefing shares
-- a trace_id. Append-only for authenticated users: SELECT and INSERT
-- policies only, no UPDATE or DELETE policy and no UPDATE/DELETE grant.
-- Both policies require an agency admin (internal Trackpr operator) who is
-- also a member of the organization - the same two checks the console
-- (app/(app)/insights/intelligence) applies - so no contractor-side user and
-- no other organization can read or write these rows.
--
-- The application only writes here when TRACKPR_AGENT_RUN_PERSISTENCE=on
-- (lib/agents/persistence.ts).

begin;

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  trace_id uuid not null,
  run_id uuid not null,
  agent_id text not null,
  status text not null,
  summary text not null,
  priority text not null,
  confidence text not null,
  requires_approval boolean not null default false,
  finding_count integer not null default 0,
  result jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms integer not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint agent_runs_run_id_key unique (run_id),
  constraint agent_runs_agent_id_check check (agent_id in ('chief_of_staff', 'sales', 'prospecting', 'trackpr_intelligence', 'qa_health', 'market_intelligence', 'engineering')),
  constraint agent_runs_status_check check (status in ('ok', 'empty', 'not_configured', 'failed')),
  constraint agent_runs_priority_check check (priority in ('critical', 'high', 'medium', 'low', 'info')),
  constraint agent_runs_confidence_check check (confidence in ('high', 'medium', 'low')),
  constraint agent_runs_summary_length check (char_length(summary) between 1 and 2000),
  constraint agent_runs_error_length check (error is null or char_length(error) <= 500),
  constraint agent_runs_finding_count_check check (finding_count >= 0),
  constraint agent_runs_duration_check check (duration_ms >= 0),
  constraint agent_runs_result_size check (pg_column_size(result) <= 262144)
);

create index if not exists agent_runs_organization_created_idx on public.agent_runs (organization_id, created_at desc);
create index if not exists agent_runs_trace_idx on public.agent_runs (trace_id);

alter table public.agent_runs enable row level security;

drop policy if exists agent_runs_select on public.agent_runs;
create policy agent_runs_select on public.agent_runs
  for select to authenticated
  using (public.is_agency_admin() and public.is_org_member(organization_id));

drop policy if exists agent_runs_insert on public.agent_runs;
create policy agent_runs_insert on public.agent_runs
  for insert to authenticated
  with check (public.is_agency_admin() and public.is_org_member(organization_id) and created_by = auth.uid());

revoke all on table public.agent_runs from anon;
revoke all on table public.agent_runs from authenticated;
grant select, insert on table public.agent_runs to authenticated;
grant all on table public.agent_runs to service_role;

commit;
