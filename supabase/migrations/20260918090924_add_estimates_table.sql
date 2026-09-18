-- Phase 4.5: Estimate Follow-Up Automation.
--
-- The "Estimates" page (app/(app)/estimates/page.tsx) has always been a
-- placeholder ("Estimate management is coming in a future update.") - there
-- is no estimates table, no CRUD, no status model anywhere in this
-- codebase. Phase 4.5's brief requires automating a communication
-- lifecycle around estimates using "the existing estimate schema" and
-- explicitly forbids inventing statuses or columns - but there is nothing
-- existing to use. Per explicit user direction, this migration adds the
-- minimal estimates table needed to give that automation something real to
-- operate on, modeled directly on the existing `appointments` table's own
-- shape and conventions (same RLS pattern, same updated_at trigger, same
-- nullable contact_id/lead_id relationship style) rather than inventing a
-- new convention.
--
-- Status model (6 values, matching the lifecycle Phase 4.5 actually asks
-- to automate): draft (created, not yet sent - no automation reachable
-- yet) -> sent (the moment follow-ups become eligible) -> exactly one of
-- accepted / declined / cancelled / expired (all terminal - follow-ups
-- stop). "cancelled" is included because the phase's own blocking-condition
-- list names it as distinct from "declined" (contractor withdrew the
-- estimate vs. customer said no); no dedicated cancelled automation event
-- is implemented this phase (not in the phase's Events list), it only
-- blocks future follow-ups by leaving the 'sent' state.
--
-- amount is nullable numeric for the contractor's own record - the
-- automation layer deliberately never includes it in outbound message text
-- (see the Phase 4.5 report for why: the existing content-safety gate
-- blanket-blocks any "$<digits>" pattern as a hallucination guard, and
-- teaching it to distinguish "real stored amount" from "invented amount"
-- would be exactly the kind of complexity this phase avoids - estimate
-- messages reference the estimate by title only).
--
-- expires_at is optional (nullable) - when set, it is the authoritative
-- signal for estimate.expired; when left null, no automatic expiration
-- happens for that estimate ("stale-estimate handling where supported").

create table public.estimates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  title text not null,
  amount numeric,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'cancelled', 'expired')),
  notes text,
  sent_at timestamp with time zone,
  responded_at timestamp with time zone,
  expires_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index idx_estimates_org on public.estimates (organization_id);
create index idx_estimates_status on public.estimates (organization_id, status);

create trigger estimates_updated_at
  before update on public.estimates
  for each row execute function set_updated_at();

alter table public.estimates enable row level security;

create policy estimates_select on public.estimates
  for select using (is_org_member(organization_id));

create policy estimates_insert on public.estimates
  for insert with check (is_org_member(organization_id));

create policy estimates_update on public.estimates
  for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy estimates_delete on public.estimates
  for delete using (is_org_member(organization_id));

grant select, insert, update, delete, references, trigger, truncate on public.estimates to anon, authenticated, service_role;
