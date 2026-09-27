-- Trackpr Phase 5D-4 - Twilio SMS Cost Intelligence.
--
-- Per the Phase 5D-4 architecture audit: Twilio SMS is the only remaining
-- provider with an authoritative per-event cost path using credentials
-- Trackpr already holds (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN - see
-- lib/automation/sms-fetch.ts). This migration adds one new, append-only
-- ledger table - sms_cost_events - mirroring ai_cost_events' and
-- revenue_events' own shape and security model exactly. Both inbound and
-- outbound SMS are in scope (both are genuinely billed by Twilio; see the
-- audit's own finding that Trackpr already has complete, reliable
-- organization attribution for both directions).
--
-- No rate_cards involvement: unlike AI cost, Twilio's own fetched `price`
-- IS the authoritative historical cost directly - there is no rate lookup
-- for this provider, and none is added here.
--
-- Automatic delayed-price reconciliation is explicitly deferred to a future
-- phase (per this phase's own scope lock) - a message whose Twilio price
-- isn't yet finalized at the moment of the one best-effort fetch attempt
-- (see lib/costs/sms-cost-events.ts) simply has no row here, and is
-- reported as "unknown" by the agency read layer, not retried automatically
-- by anything in this migration or this phase's application code.

create table if not exists public.sms_cost_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'twilio',
  service text not null default 'sms',
  -- The idempotency invariant: one Trackpr message can produce at most one
  -- successful cost event. ON DELETE RESTRICT (not CASCADE) is deliberate -
  -- this is an immutable financial ledger, and a source message must never
  -- be deletable out from under a real, already-recorded historical cost
  -- (mirrors the same correction already applied to
  -- ai_cost_events.source_interaction_id in
  -- 20260927030000_ai_cost_events_source_interaction_restrict.sql).
  -- Organization-level deletion still cascades normally via organization_id
  -- above, exactly like every other financial ledger table in this schema -
  -- this RESTRICT only closes the narrower gap of an individual message
  -- being deleted while its own cost record survives it.
  source_message_id uuid not null unique references public.messages(id) on delete restrict,
  -- The Twilio Message SID - not itself the idempotency key (that's
  -- source_message_id), but indexed for lookup/debugging and to allow
  -- tracing a cost event back to the exact Twilio resource that produced it
  -- independent of the messages table.
  provider_message_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  -- Twilio's own status string at fetch time (e.g. 'delivered', 'received',
  -- 'failed', 'undelivered') - context only, never used to gate whether a
  -- cost event exists. A failed/undelivered message can still carry a real,
  -- non-zero authoritative price and must never be assumed $0 from status
  -- alone.
  provider_status text not null,
  -- Always the already-sign-corrected cost (Twilio returns price as a
  -- negative decimal string representing a debit; this column stores
  -- Math.abs() of that value - see lib/costs/sms-cost-events.ts). Never the
  -- raw signed Twilio string.
  price numeric not null check (price >= 0),
  currency text not null,
  num_segments integer,
  num_media integer,
  -- Twilio's own dateSent (falling back to dateCreated only if dateSent is
  -- absent) - the real historical moment this SMS was sent/received by
  -- Twilio, never now() and never Trackpr's own messages.created_at or
  -- webhook-receipt time.
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- Nullable by explicit design for this table (unlike ai_cost_events'/
  -- revenue_events' own not-null-default-'{}' convention) - holds
  -- lightly-normalized raw fetch context (e.g. Twilio's own more granular
  -- direction string) only when there is something worth preserving.
  metadata jsonb
);

create index if not exists sms_cost_events_provider_message_id_idx
  on public.sms_cost_events (provider_message_id);

create index if not exists sms_cost_events_org_occurred_at_idx
  on public.sms_cost_events (organization_id, occurred_at);

alter table public.sms_cost_events enable row level security;

-- Identical security posture to ai_cost_events/revenue_events: agency-admin
-- read only, no organization-member SELECT policy at all (this is
-- Contractor Growth Co.'s own cost accounting, not client-facing data), no
-- insert/update/delete policy for authenticated/anon (service-role only,
-- via the same trusted server pathway that already writes messages.status
-- from the Twilio webhooks).
create policy sms_cost_events_select on public.sms_cost_events
  for select
  using (is_agency_admin());
