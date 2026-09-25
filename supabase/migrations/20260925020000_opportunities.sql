-- Pass 3 (Revenue Intelligence Foundation): the first-class Opportunity
-- model - a single, polymorphic, org-scoped table representing "something
-- real and actionable Trackpr detected that could mean lost or recoverable
-- business," backing the dashboard's own "N opportunities / $X estimated"
-- surface. Deliberately one table for every opportunity type (not one
-- table per type) so future types never require a new migration, matching
-- the task's own "must allow future opportunity types without a new table
-- for every type" requirement.
--
-- WHY A NEW TABLE, NOT REUSING automation_incidents/automation_events: an
-- opportunity is a business-fact observation about a lead/estimate/
-- appointment/contact ("this qualified lead never booked"), never an
-- automation-execution record - automation_incidents.category is a fixed
-- CHECK-constrained enum for automation FAILURE modes (workflow_failed,
-- sms_send_failed, etc.), and stretching it to also mean "a business
-- opportunity was detected" would conflate two genuinely different
-- concepts the same way Pass 2's own blocked_time migration rejected
-- reusing appointments for blocked time. automation_events is a durable
-- log of things that HAPPENED (an event), not a queryable, dismissible,
-- resolvable current-state record a contractor acts on - opportunities
-- need real UPDATE-in-place lifecycle (open -> resolved/dismissed), which
-- automation_events' append-only idempotency-key model was never designed
-- for.
--
-- LIFECYCLE (open / resolved / dismissed): mirrors automation_incidents'
-- own lifecycle shape (open/acknowledged/resolved) closely enough to be
-- immediately familiar, adapted to this domain's actual two terminal
-- outcomes - "resolved" (the underlying condition genuinely went away,
-- e.g. the lead got booked - set by the detector, never by a human) and
-- "dismissed" (a human explicitly said "not now" - set only by the
-- dismissOpportunity action). No "acknowledged" state: an opportunity is
-- either still actionable (open) or it isn't (resolved/dismissed) - there
-- is no automation-retry concept here for a human to acknowledge before
-- resolution, unlike an automation_incidents row.
--
-- DEDUPLICATION: a partial unique index on (organization_id, type,
-- source_entity_id) WHERE status = 'open' - the exact same shape
-- automation_incidents already established for its own
-- (organization_id, fingerprint) WHERE status IN ('open','acknowledged')
-- dedup constraint (20260919160000_automation_health_and_alerting.sql).
-- This guarantees the same underlying condition (e.g. the same lead being
-- qualified-and-unbooked) can never produce more than one OPEN opportunity
-- row at a time, while still allowing a fresh opportunity to be created
-- later if the same source entity's condition recurs after a prior
-- instance was already resolved/dismissed (e.g. a contact who was dormant,
-- got reactivated, then completed a new job and went dormant again) -
-- deliberately not a single unconditional unique constraint, which would
-- permanently block re-detection after the first resolution.
--
-- estimated_value is nullable and MUST stay that way - see this pass's own
-- terminology rules (no fabricated dollar figures, NULL means "no reliable
-- value," never coerced to 0). value_basis records, in plain English, which
-- real stored column (if any) the value came from, so the UI/AI layer can
-- always show its provenance rather than a bare number.
--
-- RLS shape matches blocked_time exactly (member-level select/insert/
-- update/delete via is_org_member, plus the organization_payment_active()
-- RESTRICTIVE policy every other ordinary business-data table already has)
-- - opportunity detection runs from the dashboard page load under the
-- viewing member's own session (see lib/opportunities/detect.ts), not a
-- service-role/cron context, so member-level write access is required, not
-- admin-only or service-role-only.

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null check (type in (
    'qualified_lead_unbooked',
    'stale_estimate',
    'completed_appointment_no_estimate',
    'dormant_customer',
    'no_show'
  )),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  -- Which real row this opportunity is ABOUT - the polymorphic source
  -- reference. Deliberately no foreign key constraint to any specific
  -- table (a lead/estimate/appointment/contact id depending on
  -- source_entity_type) - the same "no FK, RLS is the enforcement" shape
  -- automation_events.entity_id already uses for its own polymorphic
  -- entity reference, for the identical reason: one column cannot carry a
  -- real FK to four different possible tables.
  source_entity_type text not null check (source_entity_type in ('lead', 'estimate', 'appointment', 'contact')),
  source_entity_id uuid not null,
  -- Real FK, ON DELETE SET NULL (matching leads/review_requests/
  -- referral_requests' own existing convention for non-revenue-table
  -- contact references, not the RESTRICT contact deletion protection
  -- reserved for appointments/estimates/jobs/memberships/check_ins) -
  -- always populated when known, used for display and for excluding a
  -- contact's other opportunities once one of theirs is resolved.
  contact_id uuid references public.contacts(id) on delete set null,
  title text not null,
  description text,
  -- Real, nullable numeric - never coerced to 0, never fabricated. NULL
  -- means "this opportunity type has no reliable dollar figure," a normal
  -- and expected value, not a data-quality problem.
  estimated_value numeric,
  -- Plain-English provenance for estimated_value (e.g. "leads.estimated_value",
  -- "estimates.amount") - null whenever estimated_value is null. Lets the UI
  -- and any future AI narrative always cite where a shown number came from,
  -- rather than presenting a bare figure.
  value_basis text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Small, structured, type-specific extra context (e.g. the dormant
  -- customer's inactivity-day count, the stale estimate's expiration date)
  -- - the same "reuse a real jsonb column instead of adding a new column
  -- per type" convention workflow_executions.metadata already established
  -- in this codebase (see Pass 1's booking-context.ts).
  metadata jsonb not null default '{}'::jsonb,
  check (resolved_at is null or status in ('resolved', 'dismissed'))
);

create unique index if not exists opportunities_org_type_source_open_unique
  on public.opportunities (organization_id, type, source_entity_id)
  where status = 'open';

create index if not exists idx_opportunities_org_status on public.opportunities (organization_id, status);
create index if not exists idx_opportunities_org_created on public.opportunities (organization_id, created_at desc);
create index if not exists idx_opportunities_contact on public.opportunities (contact_id);

alter table public.opportunities enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'opportunities' and policyname = 'opportunities_select') then
    create policy opportunities_select on public.opportunities for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'opportunities' and policyname = 'opportunities_insert') then
    create policy opportunities_insert on public.opportunities for insert to authenticated with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'opportunities' and policyname = 'opportunities_update') then
    create policy opportunities_update on public.opportunities for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'opportunities' and policyname = 'opportunities_delete') then
    create policy opportunities_delete on public.opportunities for delete to authenticated using (is_org_member(organization_id));
  end if;
end $$;

drop policy if exists opportunities_payment_active on public.opportunities;
create policy opportunities_payment_active on public.opportunities as restrictive for all to public
  using (public.organization_payment_active(organization_id))
  with check (public.organization_payment_active(organization_id));

drop trigger if exists set_opportunities_updated_at on public.opportunities;
create trigger set_opportunities_updated_at
  before update on public.opportunities
  for each row execute function public.set_updated_at();

-- The one new index this pass's query patterns justify (see lib/opportunities/detect.ts's
-- dormant-customer detector, which reuses jobs.completed_at ordered per
-- contact - the exact same query shape lib/automation/customer-reactivation.ts's
-- processCustomerReactivation already runs unindexed on this column, now with
-- a second, more frequent caller: every dashboard page load, not only the
-- scheduled reactivation cron). idx_jobs_status (organization_id, status)
-- already exists (20260918134457_add_jobs_table.sql) and is not duplicated
-- here - this adds completed_at as a third key specifically to avoid a sort
-- step on the existing index's output.
create index if not exists idx_jobs_status_completed_at on public.jobs (organization_id, status, completed_at desc);
