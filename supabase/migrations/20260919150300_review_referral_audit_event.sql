-- Review & Referral Tracking V1 - audit logging for the manual,
-- contractor-confirmed terminal state transitions (a review actually being
-- left, a referral actually converting, or either being declined). Follows
-- the exact shape of create_organization_audit_event/create_automation_
-- audit_event: audit_log has no client-facing INSERT policy, so this is a
-- narrowly-scoped SECURITY DEFINER RPC that re-derives the actor from
-- auth.uid() and independently re-verifies is_org_member(p_organization_id)
-- itself - is_org_member, not is_org_admin, matching review_requests_
-- update/referral_requests_update's own RLS (any org member, the same
-- level of access they already have over jobs themselves) - never trusting
-- that the caller (app/(app)/jobs/actions.ts) already checked it.
--
-- Deliberately does not accept a phone number, message body, or any other
-- PII in metadata - only the entity being changed and the transition.
create or replace function public.create_review_referral_audit_event(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns public.audit_log
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_action text;
  v_entity_type text;
  v_metadata jsonb;
  v_row public.audit_log;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_organization_id is null then
    raise exception 'organization_id is required';
  end if;

  if not public.is_org_member(p_organization_id) then
    raise exception 'Not authorized';
  end if;

  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in (
    'review_marked_completed', 'review_marked_declined',
    'referral_marked_converted', 'referral_marked_declined'
  ) then
    raise exception 'Unsupported audit action';
  end if;

  v_entity_type := nullif(trim(p_entity_type), '');
  if v_entity_type is null or v_entity_type not in ('review_request', 'referral_request') then
    raise exception 'Unsupported entity type';
  end if;

  if p_entity_id is null then
    raise exception 'entity_id is required';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, v_action, v_entity_type, p_entity_id, null, v_metadata
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_review_referral_audit_event(uuid, text, text, uuid, jsonb) from public;
revoke all on function public.create_review_referral_audit_event(uuid, text, text, uuid, jsonb) from anon;
grant execute on function public.create_review_referral_audit_event(uuid, text, text, uuid, jsonb) to authenticated;
