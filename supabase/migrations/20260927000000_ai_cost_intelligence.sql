-- Trackpr Phase 5D-2 - AI Cost Intelligence.
--
-- Per the Phase 5D-2 architecture audit: Trackpr can calculate zero
-- authoritative provider dollar cost today, for any provider. AI is the
-- first (and, this phase, only) provider that can legitimately be costed
-- from data already present in this schema - and only for interactions
-- whose provider/model identity is independently trustworthy (see the
-- application-layer trust boundary in lib/costs/ai-cost-events.ts; this
-- migration adds no interaction_type allowlist itself). SMS/Twilio, voice,
-- n8n, and shared infrastructure (Vercel/Supabase) all remain out of scope -
-- see the audit's own findings for why each requires either a new provider
-- integration or external billing information this schema cannot supply.
--
-- Two tables:
--   1. rate_cards      - global, provider-level pricing history. NEVER
--                        organization-specific (no per-client pricing exists
--                        or is modeled here).
--   2. ai_cost_events  - append-only, one row per successfully-priced AI
--                        interaction. Mirrors revenue_events' own shape and
--                        security model exactly (see
--                        20260926120000_revenue_intelligence.sql): a
--                        service-role-only write surface, agency-admin-only
--                        read, no organization-member SELECT policy at all.

-- ---------------------------------------------------------------------------
-- 1. rate_cards
--
-- unit is deliberately free text, not a fixed enum - this phase only ever
-- writes 'input_token'/'output_token' rows, but the table itself is
-- provider-agnostic by design (a future SMS phase would add an
-- 'sms_segment' unit without a schema change here). effective_to is
-- nullable ("still current"); a price change never updates an existing row
-- - it closes the old row's effective_to and inserts a new one, preserving
-- full historical pricing.
-- ---------------------------------------------------------------------------

create table if not exists public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  service text not null,
  model text,
  unit text not null,
  unit_price numeric not null check (unit_price >= 0),
  currency text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

create index if not exists rate_cards_lookup_idx
  on public.rate_cards (provider, service, model, unit, active);

-- btree_gist already enabled by 20260922030000_appointment_double_booking_protection.sql -
-- reused here, not a new dependency. coalesce(model, '') sidesteps
-- NULL-vs-NULL exclusion-constraint ambiguity for provider/service-wide
-- (model-less) rates, treating "no model" as its own consistent join key
-- rather than relying on SQL NULL equality semantics inside a GiST
-- exclusion term. Scoped to active rows only - a superseded/voided rate can
-- be marked active=false without needing to satisfy this constraint, and a
-- normal price change closes the prior row's effective_to below the new
-- row's effective_from so the two ranges never overlap in the first place.
create extension if not exists btree_gist;

alter table public.rate_cards
  add constraint rate_cards_no_overlap
  exclude using gist (
    provider with =,
    service with =,
    coalesce(model, '') with =,
    unit with =,
    currency with =,
    tstzrange(effective_from, effective_to) with &&
  )
  where (active);

alter table public.rate_cards enable row level security;

-- Agency-admin read only, mirroring revenue_events_select exactly - pricing
-- math is part of Contractor Growth Co.'s own cost accounting, never a
-- client-facing table. No insert/update/delete policy: RLS defaults to
-- deny, so only a service-role connection can ever write a rate card
-- (deliberately an out-of-band/manual operation for now, matching
-- agency_admins' own "no self-service" precedent - see
-- 20260918182032_agency_command_center_foundation.sql).
create policy rate_cards_select on public.rate_cards
  for select
  using (is_agency_admin());

-- ---------------------------------------------------------------------------
-- 2. ai_cost_events
--
-- One row per successfully-priced ai_interactions row. source_interaction_id
-- is UNIQUE - the idempotency mechanism: an interaction can produce at most
-- one finalized cost event, enforced by the database, not application logic
-- alone (INSERT ... ON CONFLICT (source_interaction_id) DO NOTHING at the
-- call site - see lib/costs/ai-cost-events.ts - the exact pattern already
-- proven for ai_interactions/revenue_events). rate_card_input_id/
-- rate_card_output_id and the frozen input_unit_price/output_unit_price
-- preserve exactly which rate produced this cost, so a later rate_cards
-- correction can never retroactively change what this row reports - this
-- table is append-only; a future correction is a NEW row, never an update to
-- an existing one (no code in this migration or phase performs such an
-- update).
-- ---------------------------------------------------------------------------

create table if not exists public.ai_cost_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  service text not null,
  model text,
  source_interaction_id uuid not null unique references public.ai_interactions(id) on delete cascade,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  rate_card_input_id uuid not null references public.rate_cards(id),
  rate_card_output_id uuid not null references public.rate_cards(id),
  input_unit_price numeric not null check (input_unit_price >= 0),
  output_unit_price numeric not null check (output_unit_price >= 0),
  input_cost numeric not null check (input_cost >= 0),
  output_cost numeric not null check (output_cost >= 0),
  total_cost numeric not null check (total_cost >= 0),
  currency text not null,
  -- The AI interaction's own timestamp (ai_interactions.created_at) - the
  -- rate lookup itself is always performed against this value, never
  -- against recorded_at or "now" - see lib/costs/rate-cards.ts.
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ai_cost_events_org_occurred_at_idx
  on public.ai_cost_events (organization_id, occurred_at);

alter table public.ai_cost_events enable row level security;

-- Identical security posture to revenue_events: agency-admin read only, no
-- organization-member SELECT policy at all (this is Contractor Growth Co.'s
-- own cost accounting, not client-facing data), no insert/update/delete
-- policy for authenticated/anon (service-role only, via the same
-- application code path that inserts ai_interactions).
create policy ai_cost_events_select on public.ai_cost_events
  for select
  using (is_agency_admin());
