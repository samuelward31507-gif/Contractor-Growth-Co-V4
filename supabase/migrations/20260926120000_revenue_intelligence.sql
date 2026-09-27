-- Trackpr Phase 5D-1 - Revenue Intelligence.
--
-- Stripe remains the source of truth for payment events. This migration adds
-- the durable reporting layer: an append-only ledger of Stripe revenue
-- events (public.revenue_events) plus two nullable Stripe identifier columns
-- on public.organizations so later events (invoices, refunds) can be
-- attributed back to the organization that generated them without a live
-- Stripe API call. This is Contractor Growth Co.'s OWN revenue from its
-- clients - not contractor/customer job revenue, which stays entirely
-- unmodified (lib/bi/*, lib/agency/queries.ts).
--
-- Deliberately NOT included here (see the Phase 5D-1 task's own scope):
-- reconciliation jobs, contribution margin, provider costs, client pricing,
-- billing periods, usage billing. Manual Stripe webhook resend remains the
-- interim recovery mechanism for a missed event.

-- ---------------------------------------------------------------------------
-- 1. Stripe identifiers on organizations.
--
-- Both nullable and NOT backfilled - an organization that has never
-- completed Stripe Checkout (or predates this migration) simply has no
-- known Stripe identifier yet, which is a legitimate, common state, never an
-- error. These are identifiers, not secrets, so no extra SELECT-side
-- protection is needed - only write-side, mirroring
-- 20260921120000_organization_payment_status.sql's guard-trigger pattern
-- exactly, because organizations_update (is_org_admin) already lets an
-- organization's own admin self-service-update their own row's other
-- columns, which would otherwise let them also overwrite these two fields.
-- ---------------------------------------------------------------------------

alter table public.organizations
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists organizations_stripe_customer_id_key
  on public.organizations (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists organizations_stripe_subscription_id_key
  on public.organizations (stripe_subscription_id)
  where stripe_subscription_id is not null;

create or replace function public.guard_organizations_stripe_identifiers()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if (new.stripe_customer_id is distinct from old.stripe_customer_id
      or new.stripe_subscription_id is distinct from old.stripe_subscription_id)
     and auth.role() is distinct from 'service_role' then
    raise exception 'stripe_customer_id and stripe_subscription_id can only be changed by a trusted server-side process';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_stripe_identifiers_guard on public.organizations;
create trigger organizations_stripe_identifiers_guard
  before update on public.organizations
  for each row
  execute function public.guard_organizations_stripe_identifiers();

-- ---------------------------------------------------------------------------
-- 2. revenue_events - the append-only ledger itself.
--
-- One row per Stripe event Trackpr has chosen to record
-- (payment_succeeded/payment_failed/refund - Trackpr's own normalized
-- vocabulary, not Stripe's raw event-type strings). amount is always
-- Stripe's own minor-unit integer (e.g. cents) and always non-negative,
-- including for refunds - a refund's negative effect on collected revenue is
-- applied only at the read/reporting layer (lib/agency/revenue.ts), never by
-- negating the stored value or mutating the original payment row. Never
-- transform raw provider data on the way into storage - metadata stores the
-- lightly-normalized Stripe payload verbatim, mirroring ai_interactions.output.
-- ---------------------------------------------------------------------------

create table if not exists public.revenue_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'stripe',
  -- The idempotency key: Stripe's own event.id is globally unique across the
  -- whole Stripe account, so this is a plain unique constraint, never scoped
  -- by organization_id. The end-of-turn contract (see lib/agency/revenue.ts's
  -- ingestion helper) is INSERT ... ON CONFLICT (provider_event_id) DO
  -- NOTHING - never a SELECT-then-INSERT - so duplicate Stripe delivery
  -- always resolves to exactly one row.
  provider_event_id text not null unique,
  -- The Stripe object the event is about (an Invoice or a Charge) - not
  -- unique, since one object can generate multiple events over time (e.g. an
  -- invoice paid, then later refunded).
  provider_object_id text not null,
  event_type text not null check (event_type in ('payment_succeeded', 'payment_failed', 'refund')),
  -- Deliberately nullable with no NOT NULL constraint - for events where
  -- category genuinely cannot be determined (e.g. a mixed setup+recurring
  -- first invoice, or a refund not confidently traced to one category),
  -- preserve NULL rather than guessing.
  revenue_category text check (revenue_category in ('setup', 'recurring')),
  amount bigint not null check (amount >= 0),
  currency text not null,
  -- The real Stripe event/object timestamp - reporting always reads this,
  -- never recorded_at.
  occurred_at timestamptz not null,
  -- Operational/debugging only - when Trackpr's own webhook handler wrote
  -- this row, which can lag occurred_at (Stripe retry, delayed delivery).
  recorded_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists revenue_events_org_occurred_at_idx
  on public.revenue_events (organization_id, occurred_at);

create index if not exists revenue_events_org_type_occurred_at_idx
  on public.revenue_events (organization_id, event_type, occurred_at);

create index if not exists revenue_events_provider_object_id_idx
  on public.revenue_events (provider_object_id);

alter table public.revenue_events enable row level security;

-- Agency-admin read only. Deliberately no organization-member SELECT policy
-- at all - stricter than almost every other table in this schema, because
-- this is Contractor Growth Co.'s OWN revenue from its clients, and must
-- never become readable by a normal contractor organization member. No
-- insert/update/delete policy is granted to authenticated/anon at all - RLS
-- defaults to deny, so only a service-role connection (the Stripe webhook
-- route, via lib/supabase/service.ts) can ever write here. Unlike
-- payment_status/the Stripe-identifier columns above, no additional guard
-- trigger is needed for this brand-new table - there is no pre-existing
-- permissive write policy to carve an exception out of.
create policy revenue_events_select on public.revenue_events
  for select
  using (is_agency_admin());
