-- Rollback for payment_idempotency_and_invoice_opportunities.sql. Run as one
-- transaction, by a person, only if the forward script must be undone.
--
-- Refuses to run if either change is already in use: a customer_payments
-- row carrying a client_key (dropping the column would silently discard the
-- idempotency evidence for real money) or an opportunity row of either new
-- type (re-adding the narrower CHECK would fail on them anyway).

do $$ begin
  if exists (select 1 from public.customer_payments where client_key is not null) then
    raise exception 'Refusing to roll back: customer_payments rows carry a client_key';
  end if;
  if exists (select 1 from public.opportunities where type in ('completed_job_not_invoiced', 'invoice_overdue')) then
    raise exception 'Refusing to roll back: opportunities of the new types exist';
  end if;
end $$;

alter table public.opportunities
  drop constraint if exists opportunities_type_check;

alter table public.opportunities
  add constraint opportunities_type_check
  check (type in (
    'qualified_lead_unbooked',
    'stale_estimate',
    'completed_appointment_no_estimate',
    'dormant_customer',
    'no_show',
    'completed_job_no_referral_request',
    'completed_job_no_review_request',
    'cancelled_appointment_no_rebooking',
    'uncontacted_lead',
    'accepted_estimate_no_job',
    'active_lead_signal',
    'pending_estimate'
  ));

-- Restore customer_payments_immutable to its 20260928162500 body, byte-for-byte
-- (the forward script only added the client_key comparison).
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

drop index if exists public.customer_payments_org_client_key_unique;

alter table public.customer_payments
  drop constraint if exists customer_payments_client_key_shape;

alter table public.customer_payments
  drop column if exists client_key;
