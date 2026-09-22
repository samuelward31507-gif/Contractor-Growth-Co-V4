-- Launch Blocker #5: founder-facing client automation kill switch.
--
-- WHY A NEW COLUMN, NOT organization_mode: organizations.automation_mode
-- already gates automated outbound sends (evaluateOutboundGate denies
-- unless automation_mode = 'live'), but it has a hard CHECK constraint to
-- exactly ('test', 'live') and is read by onboarding readiness/checklist
-- code, the Settings automation-mode UI, and canGoLive - all of which
-- assume exactly those two values. Overloading it with a third 'paused'
-- value would require widening that CHECK constraint and auditing every
-- one of those call sites, and would lose the org's prior mode (test vs
-- live) on resume unless a second column stored it anyway - no smaller
-- than just adding one. A dedicated, orthogonal boolean is the minimal,
-- non-invasive change: it can only ever ADD a restriction on top of
-- automation_mode, never interact with or change it, and resuming trivially
-- restores exactly what automation_mode already was.
--
-- ENFORCEMENT: lib/automation/outbound-gate.ts already fetches
-- organizations.automation_mode in evaluateOutboundGate() - this adds
-- automation_paused to that same query and one more denial check,
-- positioned immediately alongside the existing organization_not_live
-- check. No other file needs to change: every automation path (instant
-- lead response, inbound SMS reply, appointment reminders, estimate
-- follow-ups, job lifecycle, review/referral follow-ups, lead nurture/
-- reactivation) already funnels its actual customer-facing send through
-- this one function - confirmed by inspection, not assumed.
--
-- WRITE PROTECTION: mirrors guard_organizations_payment_status() exactly,
-- widened to also allow public.is_agency_admin() (not only service_role) -
-- the legitimate caller of set_organization_automation_paused() below is a
-- real agency admin's own session, which SECURITY DEFINER elevates in SQL
-- privilege but does not change auth.role()/auth.uid() for. Without this
-- trigger, the existing organizations_update (is_org_admin) policy would
-- still block an agency admin's raw REST attempt (they aren't a member of
-- the client organization), but it would NOT stop the client organization's
-- OWN admin from silently flipping this flag directly, bypassing the RPC's
-- audit trail entirely - this closes that gap the same way payment_status
-- already closed the analogous one.
--
-- AUTHORIZATION: set_organization_automation_paused() follows the exact
-- two-step shape already established in lib/agency/queries.ts
-- (verifyAgencyAdmin then loadAgencyOrganizations) translated into SQL:
-- (1) caller must be a real, authenticated agency admin (is_agency_admin()),
-- (2) the target organization must actually be in agency_organizations -
-- there is exactly one implicit agency in this system, so every agency
-- admin is uniformly authorized for every agency_organizations row, matching
-- how resolveAgencyOrganizations() itself already works; no per-admin
-- scoping exists anywhere else in this codebase to replicate here.
--
-- AUDIT: writes to the existing audit_log table via a new, narrowly-scoped
-- RPC - not a parallel audit system. Matches the exact established
-- convention of one dedicated SECURITY DEFINER RPC per action-family
-- (create_organization_audit_event, create_automation_audit_event,
-- create_review_referral_audit_event all already do this, each with its
-- own allowed-action list, all writing into the same audit_log table).
-- action is derived server-side from the boolean argument, never a
-- free-text value accepted from the caller.

alter table public.organizations
  add column if not exists automation_paused boolean not null default false;

create or replace function public.guard_organizations_automation_paused()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.automation_paused is distinct from old.automation_paused
     and auth.role() is distinct from 'service_role'
     and not public.is_agency_admin() then
    raise exception 'automation_paused can only be changed by a trusted server-side process or a verified agency admin';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_automation_paused_guard on public.organizations;
create trigger organizations_automation_paused_guard
  before update on public.organizations
  for each row
  execute function public.guard_organizations_automation_paused();

create or replace function public.set_organization_automation_paused(p_organization_id uuid, p_paused boolean)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid;
  v_action text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_organization_id is null then
    raise exception 'organization_id is required';
  end if;

  if not public.is_agency_admin() then
    raise exception 'Not authorized';
  end if;

  if not exists (
    select 1 from public.agency_organizations
    where organization_id = p_organization_id
  ) then
    raise exception 'Organization is not managed by this agency';
  end if;

  update public.organizations
  set automation_paused = p_paused
  where id = p_organization_id;

  v_action := case when p_paused then 'automation_paused' else 'automation_resumed' end;

  insert into public.audit_log (organization_id, user_id, action, entity_type, entity_id, automation_id, metadata)
  values (p_organization_id, v_user_id, v_action, 'organization', p_organization_id, null, jsonb_build_object('paused', p_paused));

  return true;
end;
$$;
