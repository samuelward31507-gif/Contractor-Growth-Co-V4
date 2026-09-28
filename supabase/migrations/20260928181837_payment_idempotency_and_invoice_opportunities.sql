-- Trackpr Phase 1B-5 - Lifecycle Signals: payment idempotency + two invoice
-- opportunity types.
--
-- STATUS: PENDING. Written and validated (supabase/pending/scratch/
-- validate-payment-idempotency.mjs) but NOT applied to production. Apply
-- deliberately per supabase/pending/README.md - never via db push. After the
-- ledger entry is read back, move this file to supabase/migrations/<version>_
-- payment_idempotency_and_invoice_opportunities.sql.
--
-- Two additive, rerun-safe changes:
--
-- 1. public.customer_payments.client_key - a client-generated, per-submission
--    key (the Record payment dialog mints one when it opens and reuses it on
--    every retry of that same submission). A partial unique index on
--    (organization_id, client_key) makes a replayed submission - a double
--    tap that slipped past the disabled button, a retried request after a
--    network error, a duplicated Server Action call - resolve to the ONE row
--    the first attempt created instead of recording the customer's money
--    twice. lib/invoices/service.ts reads the existing row back by key and
--    returns it; a race between two identical inserts is settled by this
--    index (23505), never by application state.
--
--    Scoped per organization on purpose: keys are minted in the browser and
--    are only ever meaningful within the organization that recorded the
--    payment, so two organizations can never collide with or block each
--    other. Nullable: reversal rows (which already carry their own natural
--    idempotency via customer_payments_reversal_unique) and any pre-existing
--    row simply have no key.
--
--    Append-only is preserved: customer_payments_immutable enumerates the
--    columns an UPDATE may never change, so the ONE function replaced here
--    is that trigger function, re-created with client_key added to the
--    list (the harness proved that without this line a client_key could be
--    edited after the fact). Nothing else about the ledger changes and all
--    of it is re-proven by the harness: the insert guard, the apply trigger,
--    the sign/reversal constraints, both RLS policies, the restrictive
--    payment-active policy, and the narrowed grants (authenticated: SELECT,
--    INSERT only). No policy or grant is created, replaced or dropped. The
--    rollback restores the trigger function byte-for-byte.
--
-- 2. Two new opportunity types, widening opportunities_type_check the exact
--    same way every prior type addition did (20260925110000, 20260930000000):
--
--      completed_job_not_invoiced - a job completed since invoicing went
--        live (lib/invoices/summary.ts's INVOICING_LIVE_AT) with no live
--        (non-void) invoice. Sourced from 'job'.
--      invoice_overdue - a sent/partially paid invoice whose due_date is
--        before today in the organization's timezone. Sourced from 'job'
--        (invoices_one_live_per_job guarantees one live invoice per job, so
--        the job id is the stable dedup key); the invoice id travels in
--        metadata.invoice_id, the same convention pending_estimate uses for
--        its estimate id. source_entity_type therefore needs no change.
--
--    No new column, table, policy or index on opportunities: the existing
--    member policies, the payment-active restrictive policy, the partial
--    open-row dedup index and the updated_at trigger already cover any type
--    value, since none of them enumerate types.

-- ---------------------------------------------------------------------------
-- 1. customer_payments.client_key
-- ---------------------------------------------------------------------------

alter table public.customer_payments
  add column if not exists client_key text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customer_payments'::regclass
      and conname = 'customer_payments_client_key_shape'
  ) then
    -- Long enough to be unguessable when minted from crypto.randomUUID()
    -- (36 chars), bounded so the index never carries arbitrary text, and
    -- restricted to URL-safe characters so a key is never a vector for
    -- anything but equality.
    alter table public.customer_payments
      add constraint customer_payments_client_key_shape
      check (client_key is null or (length(client_key) between 8 and 128 and client_key ~ '^[A-Za-z0-9_-]+$'));
  end if;
end $$;

create unique index if not exists customer_payments_org_client_key_unique
  on public.customer_payments (organization_id, client_key)
  where client_key is not null;

-- 1b. customer_payments_immutable: identical to 20260928162500's body except
--     for the one added `client_key` comparison. The trigger itself is
--     untouched (same name, timing and events); CREATE OR REPLACE swaps the
--     body in place.
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

-- ---------------------------------------------------------------------------
-- 2. opportunities_type_check: + completed_job_not_invoiced, invoice_overdue
-- ---------------------------------------------------------------------------

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
    'pending_estimate',
    'completed_job_not_invoiced',
    'invoice_overdue'
  ));
