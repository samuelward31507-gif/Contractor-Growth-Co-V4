-- SMS Routing & Communications Settings V1.
--
-- organizations.sms_phone_number already exists and is already read by
-- app/api/webhooks/sms/inbound/route.ts for organization routing, but had no
-- format guarantee, no uniqueness guarantee, and no configuration path. This
-- migration adds exactly the DB-level guarantees the inbound webhook's
-- single-row lookup (`.eq("sms_phone_number", to)`) depends on for
-- correctness, plus one narrowly-scoped audit RPC for the new settings
-- action - it does not touch the column's existing nullability (an
-- organization with no configured number must remain valid and unroutable,
-- not an error state).

-- 1. Format guarantee: every non-null value must be a plausible E.164
-- number, matching lib/automation/sms.ts's existing E164_PATTERN
-- (/^\+[1-9]\d{1,14}$/) exactly, so the DB can never hold a value the
-- application's own validation would already reject. NULL remains allowed.
alter table public.organizations
  add constraint organizations_sms_phone_number_e164
  check (sms_phone_number is null or sms_phone_number ~ '^\+[1-9][0-9]{1,14}$');

-- 2. Uniqueness guarantee: the inbound webhook resolves organization purely
-- by sms_phone_number, so two organizations sharing one number would make
-- inbound routing ambiguous/unsafe. A partial unique index (rather than a
-- plain unique constraint) is required specifically so multiple
-- organizations can each independently remain NULL/unconfigured - Postgres
-- unique indexes already treat NULLs as distinct from one another, but a
-- partial index over "sms_phone_number is not null" makes that intent
-- explicit rather than relying on the reader to know Postgres's NULL
-- semantics.
create unique index organizations_sms_phone_number_unique
  on public.organizations (sms_phone_number)
  where sms_phone_number is not null;

-- 3. Audit logging for SMS routing number changes, following the exact
-- shape of create_automation_audit_event (see
-- 20260919043750_automation_audit_logging.sql): audit_log has no
-- client-facing INSERT policy, so this is a narrowly-scoped SECURITY
-- DEFINER RPC that re-derives the actor from auth.uid() and independently
-- re-verifies is_org_admin(p_organization_id) itself - the same authority
-- organizations_update's own RLS policy already relies on - never trusting
-- that the caller (app/(app)/settings/sms/actions.ts) already checked it.
-- Scoped to exactly the two actions this feature needs; anything else is
-- rejected. Deliberately does not accept or store the phone number itself
-- in metadata - the audit trail records that routing configuration changed
-- and by whom, not the number, keeping this consistent with the "no
-- unnecessary PII" requirement (the number is already visible, unmasked, on
-- the settings page itself to anyone authorized to see it).
create or replace function public.create_organization_audit_event(
  p_organization_id uuid,
  p_action text,
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

  if not public.is_org_admin(p_organization_id) then
    raise exception 'Not authorized';
  end if;

  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in ('organization_sms_number_updated', 'organization_sms_number_cleared') then
    raise exception 'Unsupported audit action';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, v_action, 'organization', p_organization_id, null, v_metadata
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_organization_audit_event(uuid, text, jsonb) from public;
revoke all on function public.create_organization_audit_event(uuid, text, jsonb) from anon;
grant execute on function public.create_organization_audit_event(uuid, text, jsonb) to authenticated;
