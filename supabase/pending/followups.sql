-- P0 A4: Follow-Up Engine v1 - public.followups.
--
-- STATUS: PENDING for Production - applied to TEST only. See
-- supabase/pending/README.md.
--
-- One row per (lead, stage): what follow-up Trackpr currently owes a lead,
-- why it is waiting, what it will do next and when. It references the
-- existing lead (no contact/lead data is copied) and records results only
-- by pointing at the existing workflow_executions row - it is not a second
-- opportunity model or a second execution model.
--
-- Writes are server-side only (the service-role producer and dispatcher in
-- lib/followups/engine.ts); organization members may read their own
-- organization's rows, under the same payment-active RESTRICTIVE policy
-- every business table has. No authenticated INSERT/UPDATE/DELETE policy
-- or privilege exists, so a member can never create or mutate a follow-up
-- (in any organization).
--
-- No DROP statements (the MCP SQL tools hang on them - see README); the
-- rollback file holds the DROPs and is run by a person.
--
-- Idempotent. Rollback: followups_rollback.sql.

create table if not exists public.followups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  stage text not null,
  state text not null default 'pending',
  waiting_on text not null default 'customer',
  next_action text not null default 'send_followup',
  next_action_at timestamptz,
  attempt_count integer not null default 0,
  lease_until timestamptz,
  paused_reason text,
  exit_reason text,
  last_execution_id uuid references public.workflow_executions(id) on delete set null,
  reactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint followups_stage_check check (stage in ('lead_no_reply')),
  constraint followups_state_check check (state in ('pending', 'scheduled', 'processing', 'paused', 'completed', 'exited', 'failed')),
  constraint followups_waiting_on_check check (waiting_on in ('customer', 'business', 'appointment', 'estimate', 'payment', 'human', 'none')),
  constraint followups_next_action_check check (next_action in ('send_followup', 'retry', 'human_review', 'none')),
  constraint followups_scheduled_has_time check (state <> 'scheduled' or next_action_at is not null),
  constraint followups_attempt_count_check check (attempt_count between 0 and 10),
  constraint followups_reason_length check (char_length(coalesce(paused_reason, '')) <= 200 and char_length(coalesce(exit_reason, '')) <= 200),
  constraint followups_lead_stage_unique unique (lead_id, stage)
);

-- Due-work selection for the dispatcher, and per-organization reads (Today).
create index if not exists idx_followups_due on public.followups (next_action_at) where state = 'scheduled';
create index if not exists idx_followups_org_state on public.followups (organization_id, state);

alter table public.followups enable row level security;

do $policies$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'followups' and policyname = 'followups_select') then
    create policy followups_select on public.followups for select to authenticated using (public.is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'followups' and policyname = 'followups_payment_active') then
    create policy followups_payment_active on public.followups as restrictive for all to public
      using (public.organization_payment_active(organization_id))
      with check (public.organization_payment_active(organization_id));
  end if;
end
$policies$;

revoke all on public.followups from anon;
revoke insert, update, delete, truncate on public.followups from authenticated;
grant select on public.followups to authenticated;
grant all on public.followups to service_role;

create or replace trigger set_followups_updated_at
  before update on public.followups
  for each row execute function public.set_updated_at();
