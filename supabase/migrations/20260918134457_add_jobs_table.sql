-- Phase 4.6: Won Job / Job Lifecycle Automation.
--
-- Confirmed by audit: no jobs table, no job-related migration, no job
-- CRUD anywhere in this codebase - app/(app)/jobs/page.tsx is a
-- placeholder, exactly like estimates was before Phase 4.5. This adds the
-- minimal jobs table needed for job.created/completed/cancelled
-- automation, modeled directly on the appointments/estimates tables' own
-- shape and conventions (same RLS pattern via is_org_member, same
-- updated_at trigger, same nullable contact_id/lead_id relationship
-- style) per explicit user decision.
--
-- Status model (4 values, per explicit user decision - kept simple,
-- no additional statuses): scheduled -> in_progress -> completed
-- (terminal) or cancelled (terminal, reachable from either scheduled or
-- in_progress).
--
-- estimate_id is a real foreign key (not just a loose uuid like
-- automation_events.entity_id) because a job's origin estimate is a
-- first-class, permanent relationship for this phase's sole job-creation
-- path (estimate.accepted only, per explicit user decision) - unlike
-- contact_id/lead_id, which follow the existing nullable/ON DELETE SET
-- NULL convention because a job can outlive a deleted contact or lead
-- exactly the way appointments and estimates already do.
--
-- amount is nullable numeric for the contractor's own record only - per
-- explicit user decision, no payment_status column and no payments table
-- exist this phase. The automation layer will not state amount in
-- outbound message text, the same rule already established for estimates
-- in Phase 4.5 (the content-safety gate blanket-blocks any "$<digits>"
-- pattern as a hallucination guard).
--
-- started_at/completed_at are nullable timestamps for record-keeping;
-- no automation in this phase derives timing decisions from them (unlike
-- appointments/estimates, Phase 4.6 has no cron/reminder requirement).

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  estimate_id uuid references public.estimates(id) on delete set null,
  title text not null,
  amount numeric,
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index idx_jobs_org on public.jobs (organization_id);
create index idx_jobs_status on public.jobs (organization_id, status);
create index idx_jobs_estimate on public.jobs (estimate_id);

create trigger jobs_updated_at
  before update on public.jobs
  for each row execute function set_updated_at();

alter table public.jobs enable row level security;

create policy jobs_select on public.jobs
  for select using (is_org_member(organization_id));

create policy jobs_insert on public.jobs
  for insert with check (is_org_member(organization_id));

create policy jobs_update on public.jobs
  for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy jobs_delete on public.jobs
  for delete using (is_org_member(organization_id));

grant select, insert, update, delete, references, trigger, truncate on public.jobs to anon, authenticated, service_role;

-- One job per estimate, ever - the actual, race-proof idempotency
-- guarantee for "estimate accepted -> exactly one job" (requirement B),
-- enforced atomically at the database level rather than only by the
-- application-level automation_events idempotency key, exactly the same
-- defense-in-depth pattern already used for messages.workflow_execution_id
-- in Phase 4.3 (see 20260918082849_messages_outbound_execution_unique.sql).
-- A second concurrent job-creation attempt for the same estimate fails
-- with 23505 rather than silently succeeding twice.
create unique index jobs_estimate_id_unique on public.jobs (estimate_id) where estimate_id is not null;
