-- Trackpr Phase 1B - Invoice Foundation + Manual Customer Payments.
--
-- STATUS: APPLIED to production on 2026-09-28 via the Supabase MCP
-- apply_migration mechanism, recorded in the ledger as version
-- 20260928162500 (this filename). It was applied as one transaction WITHOUT
-- the explicit begin;/commit; lines at the bottom of this file - the
-- mechanism supplies the transaction and records the ledger entry inside
-- it; every other statement was byte-identical. Function, constraint and
-- index definitions produced by this file were fingerprinted (md5) against
-- production before the file was moved here from supabase/pending/ and all
-- 35 matched. Do not re-run it through db push: the ledger predates the
-- filename convention for most entries (see supabase/pending/README.md).
--
-- What it adds (all additive; the only existing object it touches is the
-- merge_contacts function, re-created from the body captured verbatim from
-- production in supabase/pending/reference/merge_contacts.production.sql):
--
--   public.invoices            one live invoice per job, per-organization
--                              INV numbering, draft -> sent -> partially_paid
--                              -> paid, void, frozen totals after issue,
--                              amount_paid maintained only by the payment
--                              trigger, generated balance_due.
--   public.customer_payments   append-only ledger of money the contractor
--                              received from a customer (cash, check, card
--                              run elsewhere, bank transfer, other), with
--                              reversal rows for corrections. Named with the
--                              customer_ prefix because "payment" alone
--                              already means the contractor's own Trackpr
--                              subscription everywhere in this schema.
--   create_invoice_audit_event RPC, the invoice twin of
--                              create_review_referral_audit_event.
--
-- Terminology discipline: only customer_payments sums are ever "collected".
-- invoices.total is "invoiced". jobs.amount stays "contracted",
-- estimates.amount stays "quoted". Overdue is derived from due_date at read
-- time and never stored.
--
-- Units: dollars, numeric(12,2). Postgres ROUNDS an over-precise value on
-- assignment to numeric(12,2) (10.005 -> 10.01), so sub-cent rejection is the
-- application's job (lib/invoices/domain.ts); the database guarantees two
-- decimals are stored, never more.
--
-- Idempotent: every statement is create-if-not-exists / create-or-replace /
-- drop-if-exists-then-create, so re-running it is a no-op and reports no
-- error. Re-running it never drops data.

begin;

-- ---------------------------------------------------------------------------
-- 1. invoices
-- ---------------------------------------------------------------------------

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- RESTRICT: a job that has ever been invoiced can no longer be deleted
  -- (the existing restrict_contact_delete_on_revenue_tables precedent).
  job_id uuid not null references public.jobs(id) on delete restrict,
  -- Copied from the job by the insert trigger. Nullable only because
  -- jobs.contact_id is nullable; RESTRICT so invoiced customers can't vanish.
  contact_id uuid references public.contacts(id) on delete restrict,
  estimate_id uuid references public.estimates(id) on delete set null,
  -- Per-organization counter, assigned by the insert trigger under a lock on
  -- the organization row. Rendered as INV-000001. Never reused after void.
  number integer not null check (number > 0),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'partially_paid', 'paid', 'void')),
  title text not null,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  -- Always 0 in Phase 1B. Exists so Phase 2 tax support is additive.
  tax_amount numeric(12,2) not null default 0 check (tax_amount >= 0),
  total numeric(12,2) not null check (total >= 0),
  -- Maintained ONLY by customer_payments_apply (see guard below).
  amount_paid numeric(12,2) not null default 0,
  balance_due numeric(12,2) generated always as (total - amount_paid) stored,
  issued_at timestamp with time zone,
  sent_at timestamp with time zone,
  -- A calendar date in the organization's timezone. Overdue = status in
  -- (sent, partially_paid) and due_date < today-in-that-timezone, derived at
  -- read time, never stored.
  due_date date,
  paid_at timestamp with time zone,
  voided_at timestamp with time zone,
  void_reason text,
  -- Internal only. Never selected by any customer-facing surface (the Phase
  -- 1A lesson on estimates.notes).
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint invoices_total_matches_parts check (total = subtotal + tax_amount),
  constraint invoices_amount_paid_within_total check (amount_paid >= 0 and amount_paid <= total),
  -- A draft voided before issue legitimately has no issued_at/due_date.
  constraint invoices_issued_fields_present check (status in ('draft', 'void') or (issued_at is not null and due_date is not null)),
  constraint invoices_void_stamped check (status <> 'void' or voided_at is not null),
  constraint invoices_org_number_unique unique (organization_id, number)
);

create index if not exists idx_invoices_org_status on public.invoices (organization_id, status);
create index if not exists idx_invoices_org_due on public.invoices (organization_id, due_date);
create index if not exists idx_invoices_job on public.invoices (job_id);
create index if not exists idx_invoices_contact on public.invoices (contact_id);
-- One live invoice per job. Void frees the job for a re-issue; the partial
-- unique index is the same race-proof guarantee jobs_estimate_id_unique gives
-- "one job per estimate".
create unique index if not exists invoices_one_live_per_job on public.invoices (job_id) where status <> 'void';

drop trigger if exists invoices_updated_at on public.invoices;
create trigger invoices_updated_at
  before update on public.invoices
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. customer_payments
-- ---------------------------------------------------------------------------

create table if not exists public.customer_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  -- Denormalized from the invoice by the insert trigger so per-job and
  -- per-customer collected sums never need to join through a voidable parent.
  job_id uuid not null references public.jobs(id) on delete restrict,
  contact_id uuid references public.contacts(id) on delete restrict,
  -- Positive for money received. Negative ONLY on a reversal row (see
  -- customer_payments_sign_matches_kind) and then exactly the negative of the
  -- payment it reverses.
  amount numeric(12,2) not null check (amount <> 0),
  method text not null
    check (method in ('cash', 'check', 'card_elsewhere', 'bank_transfer', 'other')),
  reference text,
  received_at timestamp with time zone not null default now(),
  -- Set only on a correction row. The original row is never modified; the
  -- unique constraint below means a payment can be reversed at most once,
  -- and the insert trigger refuses to reverse a reversal.
  reverses_payment_id uuid references public.customer_payments(id) on delete restrict,
  recorded_by uuid,
  notes text,
  created_at timestamp with time zone not null default now(),
  constraint customer_payments_sign_matches_kind check (
    (reverses_payment_id is null and amount > 0) or (reverses_payment_id is not null and amount < 0)
  ),
  constraint customer_payments_reversal_unique unique (reverses_payment_id)
);

create index if not exists idx_customer_payments_org_received on public.customer_payments (organization_id, received_at);
create index if not exists idx_customer_payments_invoice on public.customer_payments (invoice_id);
create index if not exists idx_customer_payments_job on public.customer_payments (job_id);
create index if not exists idx_customer_payments_contact on public.customer_payments (contact_id);

-- ---------------------------------------------------------------------------
-- 3. Triggers: the rules live here so they hold for every client, including
--    a service-role connection that bypasses RLS.
-- ---------------------------------------------------------------------------

-- 3a. Invoice insert: verify the job, copy its relationships, assign the
--     number, and force the draft shape regardless of what the client sent.
create or replace function public.invoices_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs
    where id = new.job_id and organization_id = new.organization_id;
  if not found then
    raise exception 'job_id must belong to the same organization_id';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'A cancelled job cannot receive a new invoice';
  end if;

  -- Relationships come from the job, never from the client.
  new.contact_id := v_job.contact_id;
  new.estimate_id := v_job.estimate_id;

  -- Every invoice is born a draft with nothing collected. A client cannot
  -- create a pre-paid or pre-issued invoice in one write.
  new.status := 'draft';
  new.amount_paid := 0;
  new.issued_at := null;
  new.sent_at := null;
  new.paid_at := null;
  new.voided_at := null;
  new.void_reason := null;
  new.created_by := coalesce(new.created_by, auth.uid());

  -- Serialize numbering per organization: the lock on the organization row
  -- is held to the end of the transaction, so two concurrent inserts for the
  -- same organization queue here and each sees the other's number.
  -- invoices_org_number_unique remains the backstop.
  perform 1 from public.organizations where id = new.organization_id for update;
  select coalesce(max(number), 0) + 1 into new.number
    from public.invoices where organization_id = new.organization_id;

  return new;
end;
$$;

drop trigger if exists invoices_guard_insert on public.invoices;
create trigger invoices_guard_insert
  before insert on public.invoices
  for each row execute function public.invoices_guard_insert();

-- 3b. Invoice update: immutable identity, frozen money after issue,
--     amount_paid/paid_at only via the payment trigger, explicit status
--     transitions, stamps on issue and void.
create or replace function public.invoices_guard_update()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_applying boolean := coalesce(current_setting('trackpr.applying_payment', true), '') = '1';
  v_tz text;
begin
  if new.organization_id <> old.organization_id
     or new.job_id <> old.job_id
     or new.number <> old.number
     or new.estimate_id is distinct from old.estimate_id
     or new.created_at <> old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'invoice identity columns are immutable';
  end if;

  -- contact_id may only move to another contact of the same organization
  -- (merge_contacts reassigns it; nothing else should).
  if new.contact_id is distinct from old.contact_id then
    if new.contact_id is null or not exists (
      select 1 from public.contacts where id = new.contact_id and organization_id = new.organization_id
    ) then
      raise exception 'contact_id must belong to the same organization_id';
    end if;
  end if;

  if old.status = 'void' and new.contact_id is not distinct from old.contact_id then
    raise exception 'A void invoice is read-only';
  end if;

  -- Money is frozen the moment an invoice leaves draft.
  if old.status <> 'draft' and (
       new.subtotal <> old.subtotal
    or new.tax_amount <> old.tax_amount
    or new.total <> old.total
  ) then
    raise exception 'subtotal, tax_amount and total are frozen once an invoice has been issued';
  end if;

  -- Only customer_payments_apply may move amount_paid / paid_at.
  if not v_applying and (new.amount_paid <> old.amount_paid or new.paid_at is distinct from old.paid_at) then
    raise exception 'amount_paid and paid_at are maintained by customer payments, not by direct update';
  end if;

  if new.status <> old.status then
    if v_applying then
      -- The payment trigger only ever moves between the three issued states.
      if old.status not in ('sent', 'partially_paid', 'paid')
         or new.status not in ('sent', 'partially_paid', 'paid') then
        raise exception 'invalid payment-driven status transition % -> %', old.status, new.status;
      end if;
    elsif old.status = 'draft' and new.status = 'sent' then
      select timezone into v_tz from public.organizations where id = new.organization_id;
      new.issued_at := coalesce(new.issued_at, now());
      new.sent_at := coalesce(new.sent_at, new.issued_at);
      -- Default due date: 14 days after the issue date, in the organization's
      -- own timezone (a job finished at 11pm in Denver is still "today").
      new.due_date := coalesce(new.due_date, (new.issued_at at time zone coalesce(v_tz, 'UTC'))::date + 14);
    elsif new.status = 'void' and old.status in ('draft', 'sent') then
      if old.amount_paid <> 0 then
        raise exception 'An invoice with recorded payments cannot be voided; reverse the payments first';
      end if;
      new.voided_at := coalesce(new.voided_at, now());
    else
      raise exception 'invalid invoice status transition % -> %', old.status, new.status;
    end if;
  elsif old.status = 'draft' and (new.issued_at is distinct from old.issued_at or new.sent_at is distinct from old.sent_at) then
    raise exception 'issued_at and sent_at are set by issuing the invoice';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_guard_update on public.invoices;
create trigger invoices_guard_update
  before update on public.invoices
  for each row execute function public.invoices_guard_update();

-- 3c. Invoice delete: only an unissued draft can ever be deleted. Issued
--     invoices are historical records; void them instead.
create or replace function public.invoices_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if old.status <> 'draft' then
    raise exception 'Issued invoices cannot be deleted; void them instead';
  end if;
  return old;
end;
$$;

drop trigger if exists invoices_guard_delete on public.invoices;
create trigger invoices_guard_delete
  before delete on public.invoices
  for each row execute function public.invoices_guard_delete();

-- 3d. Payment insert: verify the invoice under a row lock, copy its
--     relationships, validate ordinary vs reversal rows, reject overpayment.
create or replace function public.customer_payments_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_inv public.invoices%rowtype;
  v_orig public.customer_payments%rowtype;
  v_new_paid numeric(12,2);
begin
  -- The lock serializes every payment against the same invoice, so two
  -- concurrent partial payments cannot both pass the overpayment check.
  select * into v_inv from public.invoices where id = new.invoice_id for update;
  if not found or v_inv.organization_id <> new.organization_id then
    raise exception 'invoice_id must belong to the same organization_id';
  end if;

  new.job_id := v_inv.job_id;
  new.contact_id := v_inv.contact_id;
  new.recorded_by := coalesce(new.recorded_by, auth.uid());
  new.received_at := coalesce(new.received_at, now());

  if new.reverses_payment_id is null then
    if new.amount <= 0 then
      raise exception 'A payment must be a positive amount';
    end if;
    if v_inv.status not in ('sent', 'partially_paid') then
      raise exception 'Payments can only be recorded against an issued, unpaid invoice (status is %)', v_inv.status;
    end if;
  else
    select * into v_orig from public.customer_payments where id = new.reverses_payment_id;
    if not found or v_orig.invoice_id <> new.invoice_id then
      raise exception 'A reversal must reference a payment on the same invoice';
    end if;
    if v_orig.reverses_payment_id is not null then
      raise exception 'A reversal cannot itself be reversed';
    end if;
    if exists (select 1 from public.customer_payments where reverses_payment_id = v_orig.id) then
      raise exception 'This payment has already been reversed';
    end if;
    if new.amount <> -v_orig.amount then
      raise exception 'A reversal must exactly offset the payment it reverses';
    end if;
    if v_inv.status not in ('sent', 'partially_paid', 'paid') then
      raise exception 'Payments on a % invoice cannot be reversed', v_inv.status;
    end if;
    -- A reversal keeps the original method so the ledger reads as a pair.
    new.method := v_orig.method;
  end if;

  v_new_paid := v_inv.amount_paid + new.amount;
  if v_new_paid > v_inv.total then
    raise exception 'Payment of % would exceed the balance due of %', new.amount, v_inv.total - v_inv.amount_paid;
  end if;
  if v_new_paid < 0 then
    raise exception 'Reversal would take the amount paid below zero';
  end if;

  return new;
end;
$$;

drop trigger if exists customer_payments_guard_insert on public.customer_payments;
create trigger customer_payments_guard_insert
  before insert on public.customer_payments
  for each row execute function public.customer_payments_guard_insert();

-- 3e. Payment apply: recompute the invoice from the full ledger (never
--     incrementally) and move its status. The transaction-local flag is the
--     only thing that lets invoices_guard_update accept the change.
create or replace function public.customer_payments_apply()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_paid numeric(12,2);
  v_total numeric(12,2);
begin
  select coalesce(sum(amount), 0) into v_paid from public.customer_payments where invoice_id = new.invoice_id;
  select total into v_total from public.invoices where id = new.invoice_id;

  perform set_config('trackpr.applying_payment', '1', true);
  update public.invoices set
    amount_paid = v_paid,
    status = case
      when v_paid >= v_total then 'paid'
      when v_paid > 0 then 'partially_paid'
      else 'sent'
    end,
    paid_at = case when v_paid >= v_total then coalesce(paid_at, now()) else null end
  where id = new.invoice_id;
  perform set_config('trackpr.applying_payment', '0', true);

  return new;
end;
$$;

drop trigger if exists customer_payments_apply on public.customer_payments;
create trigger customer_payments_apply
  after insert on public.customer_payments
  for each row execute function public.customer_payments_apply();

-- 3f. Payment immutability: rows are history. The single permitted UPDATE is
--     contact_id moving to another contact of the same organization with
--     nothing else changing, which is exactly what merge_contacts does.
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

drop trigger if exists customer_payments_immutable on public.customer_payments;
create trigger customer_payments_immutable
  before update or delete on public.customer_payments
  for each row execute function public.customer_payments_immutable();

-- ---------------------------------------------------------------------------
-- 4. RLS, payment-active gate, grants
-- ---------------------------------------------------------------------------

alter table public.invoices enable row level security;
alter table public.customer_payments enable row level security;

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select to authenticated using (is_org_member(organization_id));
drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices
  for insert to authenticated with check (is_org_member(organization_id));
drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices
  for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
-- Deliberately no delete policy: even a draft is deleted only by a trusted
-- server path, never from a browser session.

drop policy if exists customer_payments_select on public.customer_payments;
create policy customer_payments_select on public.customer_payments
  for select to authenticated using (is_org_member(organization_id));
drop policy if exists customer_payments_insert on public.customer_payments;
create policy customer_payments_insert on public.customer_payments
  for insert to authenticated with check (is_org_member(organization_id));
-- Deliberately no update and no delete policy: append-only.

-- Payment gate: same restrictive policy shape 20260921150000 applied to every
-- gated table, added here per table exactly as later tables (opportunities,
-- memberships, blocked_time, ...) did, rather than editing the original list.
drop policy if exists invoices_payment_active on public.invoices;
create policy invoices_payment_active on public.invoices
  as restrictive for all to public
  using (public.organization_payment_active(organization_id))
  with check (public.organization_payment_active(organization_id));
drop policy if exists customer_payments_payment_active on public.customer_payments;
create policy customer_payments_payment_active on public.customer_payments
  as restrictive for all to public
  using (public.organization_payment_active(organization_id))
  with check (public.organization_payment_active(organization_id));

-- Narrower than the estimates/jobs grants on purpose: no anon, no delete on
-- invoices for members, no update/delete at all on customer_payments.
grant select, insert, update on public.invoices to authenticated, service_role;
grant delete on public.invoices to service_role;
grant select, insert on public.customer_payments to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Audit RPC - the invoice twin of create_review_referral_audit_event.
--    Server actions call it after every transition so the Activity timeline
--    (audit_log) shows money events. Amounts belong in metadata here, never
--    in a customer-facing message.
-- ---------------------------------------------------------------------------

create or replace function public.create_invoice_audit_event(
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

  if not public.organization_payment_active(p_organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in (
    'invoice_created', 'invoice_issued', 'invoice_voided',
    'payment_recorded', 'payment_reversed'
  ) then
    raise exception 'Unsupported audit action';
  end if;

  v_entity_type := nullif(trim(p_entity_type), '');
  if v_entity_type is null or v_entity_type not in ('invoice', 'customer_payment') then
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

-- ---------------------------------------------------------------------------
-- 6. merge_contacts: the one existing object this migration touches.
--    Body is the production definition captured verbatim in
--    supabase/pending/reference/merge_contacts.production.sql (md5
--    16eb8b6540778969e6d489953494c44b), with exactly one addition: the
--    "-- invoices" and "-- customer_payments" blocks after review_requests.
--    customer_payments_immutable permits this specific contact_id-only
--    UPDATE; invoices_guard_update permits contact_id moving within the
--    organization. Everything else in the body is byte-identical.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.merge_contacts(p_organization_id uuid, p_source_contact_id uuid, p_target_contact_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_source record;
  v_target record;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
  v_source_open_conv record;
  v_target_has_open boolean;
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

  if not public.organization_payment_active(p_organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  if p_source_contact_id is null or p_target_contact_id is null then
    raise exception 'source and target contact ids are required';
  end if;

  if p_source_contact_id = p_target_contact_id then
    raise exception 'Cannot merge a contact into itself';
  end if;

  select * into v_source from public.contacts
    where id = p_source_contact_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'Source contact not found in this organization';
  end if;

  select * into v_target from public.contacts
    where id = p_target_contact_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'Target contact not found in this organization';
  end if;

  if v_source.merged_into_id is not null then
    raise exception 'Source contact has already been merged';
  end if;
  if v_target.merged_into_id is not null then
    raise exception 'Target contact has already been merged - merge into its current survivor instead';
  end if;

  update public.contacts set
    merged_into_id = p_target_contact_id,
    merged_at = now()
  where id = p_source_contact_id;

  update public.contacts set
    first_name = coalesce(nullif(trim(v_target.first_name), ''), v_source.first_name),
    last_name = coalesce(nullif(trim(v_target.last_name), ''), v_source.last_name),
    company_name = coalesce(nullif(trim(v_target.company_name), ''), v_source.company_name),
    notes = coalesce(nullif(trim(v_target.notes), ''), v_source.notes),
    phone = case when v_target.phone is not null and trim(v_target.phone) <> '' then v_target.phone else v_source.phone end,
    phone_normalized = case when v_target.phone is not null and trim(v_target.phone) <> '' then v_target.phone_normalized else v_source.phone_normalized end,
    email = case when v_target.email is not null and trim(v_target.email) <> '' then v_target.email else v_source.email end,
    email_normalized = case when v_target.email is not null and trim(v_target.email) <> '' then v_target.email_normalized else v_source.email_normalized end
  where id = p_target_contact_id;

  -- ai_interactions
  update public.ai_interactions set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('ai_interactions', v_n);

  -- appointments
  update public.appointments set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('appointments', v_n);

  -- estimates
  update public.estimates set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('estimates', v_n);

  -- jobs
  update public.jobs set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('jobs', v_n);

  -- leads (no uniqueness hazard - a contact may have multiple leads)
  update public.leads set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_n);

  -- referral_requests (unique on job_id, not contact_id - no hazard)
  update public.referral_requests set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('referral_requests', v_n);

  -- review_requests (same - unique on job_id)
  update public.review_requests set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('review_requests', v_n);

  -- invoices (Phase 1B: unique on (job_id) where live, not contact_id - no
  -- hazard; invoices_guard_update allows contact_id to move within the org)
  update public.invoices set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('invoices', v_n);

  -- customer_payments (Phase 1B: append-only, but customer_payments_immutable
  -- permits exactly this contact_id-only reassignment)
  update public.customer_payments set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_payments', v_n);

  -- opportunities (Pass 4 P0 fix - see this migration's own header. No
  -- uniqueness hazard: contact_id is not part of
  -- opportunities_org_type_source_open_unique.)
  update public.opportunities set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('opportunities', v_n);

  -- conversations: the one real uniqueness hazard. For every OPEN
  -- conversation the source has, on a channel where the target ALSO
  -- already has an open conversation, close the source's conversation
  -- first (history preserved, just no longer "the" open thread) so
  -- reassigning it can never violate conversations_org_contact_channel_
  -- open_key. Every other conversation (closed, or open on a channel the
  -- target has no open thread on) is reassigned as-is.
  for v_source_open_conv in
    select id, channel from public.conversations
    where contact_id = p_source_contact_id and status = 'open'
  loop
    select exists (
      select 1 from public.conversations
      where contact_id = p_target_contact_id
        and channel = v_source_open_conv.channel
        and status = 'open'
    ) into v_target_has_open;

    if v_target_has_open then
      update public.conversations set status = 'closed' where id = v_source_open_conv.id;
    end if;
  end loop;

  update public.conversations set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_n);

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, 'contact_merged', 'contact', p_target_contact_id, null,
    jsonb_build_object(
      'source_contact_id', p_source_contact_id,
      'target_contact_id', p_target_contact_id,
      'reason', p_reason,
      'reassigned_counts', v_counts
    )
  );

  return jsonb_build_object(
    'ok', true,
    'source_contact_id', p_source_contact_id,
    'target_contact_id', p_target_contact_id,
    'reassigned_counts', v_counts
  );
end;
$function$;

commit;
