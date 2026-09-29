-- Rollback for online_payments.sql. Run as one transaction (the script wraps
-- itself), by a person, only if the forward script must be undone.
--
-- Refuses to run if any part of Phase 1C is already in use, because each
-- would be silently destroyed:
--   - a card_online customer_payments row (real money collected through
--     Stripe; the narrower method CHECK could not be re-added anyway),
--   - an online_payment_reconciliation incident (an open reconciliation task
--     for real money; the narrower category CHECK could not be re-added),
--   - an organization with a stored Stripe Connect account id (dropping it
--     would orphan a real connected Stripe account from its organization).
-- invoices.payment_token is dropped without a guard: dropping it only breaks
-- links already sent to customers, which is exactly what undoing the feature
-- means. After real online payments exist, do not roll back; hide the UI.
--
-- Restores customer_payments_immutable to its 20260928181837 body and
-- record_automation_incident_signal to the captured body in
-- reference/record_automation_incident_signal.captured.sql, both
-- byte-for-byte.

begin;

do $$ begin
  if exists (select 1 from public.customer_payments where method = 'card_online') then
    raise exception 'Refusing to roll back: card_online customer payments exist';
  end if;
  if exists (select 1 from public.automation_incidents where category = 'online_payment_reconciliation') then
    raise exception 'Refusing to roll back: online_payment_reconciliation incidents exist';
  end if;
  if exists (select 1 from public.organizations where stripe_connect_account_id is not null) then
    raise exception 'Refusing to roll back: organizations have a Stripe Connect account id';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. automation incidents
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_automation_incident_signal(p_organization_id uuid, p_category text, p_severity text, p_fingerprint text, p_title text, p_description text DEFAULT NULL::text, p_automation_id text DEFAULT NULL::text, p_workflow_execution_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS automation_incidents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_service_role boolean;
  v_category text;
  v_severity text;
  v_fingerprint text;
  v_title text;
  v_description text;
  v_automation_id text;
  v_metadata jsonb;
  v_row public.automation_incidents;
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
    if not public.organization_payment_active(p_organization_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;

  v_category := nullif(trim(p_category), '');
  if v_category is null or v_category not in (
    'workflow_failed', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed',
    'human_escalation_requested',
    'scheduled_automation_stale'
  ) then
    raise exception 'Unsupported incident category';
  end if;

  v_severity := nullif(trim(p_severity), '');
  if v_severity is null or v_severity not in ('info', 'warning', 'critical') then
    raise exception 'Unsupported incident severity';
  end if;

  v_fingerprint := nullif(trim(p_fingerprint), '');
  if v_fingerprint is null or length(v_fingerprint) > 300 then
    raise exception 'Invalid fingerprint';
  end if;

  v_title := nullif(trim(p_title), '');
  if v_title is null or length(v_title) > 200 then
    raise exception 'Invalid title';
  end if;

  v_description := nullif(trim(p_description), '');
  if v_description is not null then
    v_description := left(v_description, 1000);
  end if;

  v_automation_id := nullif(trim(p_automation_id), '');

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.automation_incidents as ai (
    organization_id, automation_id, workflow_execution_id, category, severity, status,
    fingerprint, title, description, metadata
  ) values (
    p_organization_id, v_automation_id, p_workflow_execution_id, v_category, v_severity, 'open',
    v_fingerprint, v_title, v_description, v_metadata
  )
  on conflict (organization_id, fingerprint) where status in ('open', 'acknowledged')
  do update set
    occurrence_count = ai.occurrence_count + 1,
    last_seen_at = now(),
    workflow_execution_id = coalesce(excluded.workflow_execution_id, ai.workflow_execution_id),
    title = excluded.title,
    description = excluded.description,
    metadata = excluded.metadata,
    updated_at = now(),
    category = case
      when ai.category = 'workflow_failed' and ai.occurrence_count + 1 >= 3 then 'repeated_workflow_failure'
      else ai.category
    end,
    severity = case
      when ai.category = 'workflow_failed' and ai.occurrence_count + 1 >= 3 then 'critical'
      else ai.severity
    end
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) from public;
revoke all on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) from anon;
grant execute on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) to authenticated, service_role;

alter table public.automation_incidents
  drop constraint if exists automation_incidents_category_check;

alter table public.automation_incidents
  add constraint automation_incidents_category_check check (category in (
    'workflow_failed', 'repeated_workflow_failure', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed',
    'human_escalation_requested',
    'scheduled_automation_stale'
  ));

-- ---------------------------------------------------------------------------
-- 3. customer_payments
-- ---------------------------------------------------------------------------

drop trigger if exists customer_payments_online_guard on public.customer_payments;
drop function if exists public.customer_payments_online_guard();

-- Restore customer_payments_immutable to its 20260928181837 body, byte-for-byte.
create or replace function public.customer_payments_immutable()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'customer_payments are append-only; record a reversal instead of deleting';
  end if;

  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.invoice_id <> old.invoice_id
     or new.job_id <> old.job_id
     or new.amount <> old.amount
     or new.method <> old.method
     or new.reference is distinct from old.reference
     or new.received_at <> old.received_at
     or new.reverses_payment_id is distinct from old.reverses_payment_id
     or new.recorded_by is distinct from old.recorded_by
     or new.notes is distinct from old.notes
     or new.client_key is distinct from old.client_key
     or new.created_at <> old.created_at then
    raise exception 'customer_payments are append-only; record a reversal instead of editing';
  end if;

  if new.contact_id is distinct from old.contact_id then
    if new.contact_id is null or not exists (
      select 1 from public.contacts where id = new.contact_id and organization_id = new.organization_id
    ) then
      raise exception 'contact_id must belong to the same organization_id';
    end if;
  end if;

  return new;
end;
$$;

drop index if exists public.customer_payments_stripe_payment_intent_unique;
drop index if exists public.customer_payments_stripe_checkout_session_unique;

alter table public.customer_payments
  drop constraint if exists customer_payments_stripe_fields;

alter table public.customer_payments
  drop constraint if exists customer_payments_method_check;

alter table public.customer_payments
  add constraint customer_payments_method_check
  check (method in ('cash', 'check', 'card_elsewhere', 'bank_transfer', 'other'));

alter table public.customer_payments
  drop column if exists stripe_account_id,
  drop column if exists stripe_payment_intent_id,
  drop column if exists stripe_checkout_session_id;

-- ---------------------------------------------------------------------------
-- 2. invoices.payment_token
-- ---------------------------------------------------------------------------

drop trigger if exists invoices_payment_token_guard on public.invoices;
drop function if exists public.invoices_payment_token_guard();
drop index if exists public.invoices_payment_token_unique;

alter table public.invoices
  drop constraint if exists invoices_payment_token_shape;

alter table public.invoices
  drop column if exists payment_token;

-- ---------------------------------------------------------------------------
-- 1. organizations
-- ---------------------------------------------------------------------------

drop trigger if exists organizations_stripe_connect_guard on public.organizations;
drop function if exists public.guard_organizations_stripe_connect();
drop index if exists public.organizations_stripe_connect_account_id_key;

alter table public.organizations
  drop constraint if exists organizations_stripe_connect_account_id_shape;

alter table public.organizations
  drop column if exists stripe_connect_synced_at,
  drop column if exists stripe_connect_details_submitted,
  drop column if exists stripe_connect_payouts_enabled,
  drop column if exists stripe_connect_charges_enabled,
  drop column if exists stripe_connect_account_id;

commit;
