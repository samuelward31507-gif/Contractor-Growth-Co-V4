-- Performance Pass 2 (Opportunity Sync Throttling): an atomic, per-organization
-- 5-minute cooldown for the Dashboard's background opportunity sync.
--
-- STATUS: PENDING - not applied anywhere. See supabase/pending/README.md for
-- the apply procedure (a person applies it; the file moves into
-- supabase/migrations/ only under the ledger version it produces).
--
-- WHY: every Dashboard view schedules after() -> syncOpportunities
-- (lib/opportunities/background-sync.ts): ~28 Supabase reads, ~40% of the
-- Supabase time of a Dashboard view, with no dedup across requests - rapid
-- navigation, prefetches and multiple tabs each run a full sync, and
-- overlapping syncs were observed in production 0.39 s apart. The sync
-- itself is unchanged; this only decides whether a given view runs it.
--
-- WHAT (additive; nothing existing is altered):
--
-- 1. public.opportunity_sync_state - one row per organization holding when its
--    last sync was claimed. RLS enabled with NO policies, and every table
--    privilege revoked from public/anon/authenticated: the project's default
--    privileges (pg_default_acl) grant ALL on each new table to anon and
--    authenticated, so RLS-without-policies alone would still leave table
--    grants in place (the invoice_foundation_grants precedent). The only
--    way in is the function below; service_role keeps its default grants,
--    like every other table, and is never used by this feature.
--
-- 2. public.claim_opportunity_sync(p_organization_id uuid) -> boolean.
--    SECURITY DEFINER with search_path pinned to public (this codebase's
--    convention); execute revoked from public and anon, granted to
--    authenticated only. Returns true for exactly one caller per
--    organization per 5 minutes, false otherwise - never an error, so a
--    caller can't learn whether another organization exists.
--
--    Authorization is exactly the sync's own existing rules, by calling the
--    existing helpers rather than copying them (a copied body can drift - see
--    lib/auth/payment-gate-rpc-enforcement.integration.test.ts for the
--    history): auth.uid() must be non-null, public.is_org_member() (any
--    role - owner, admin or member, the same rule the opportunities policies
--    apply) and public.organization_payment_active() ('active' only - the
--    same rule the restrictive payment policies apply). Both helpers are
--    themselves SECURITY DEFINER, and this function is owned by the migration
--    runner (postgres), which owns the tables with RLS not forced - so no
--    lookup here depends on, or recurses through, RLS. A caller can only
--    claim for an organization they belong to, so no one can suppress
--    another organization's sync.
--
--    Atomicity: one INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING.
--    Under READ COMMITTED a concurrent second caller waits on the row lock,
--    re-evaluates the WHERE against the committed last_started_at and gets
--    no row back - exactly one caller wins. The cooldown is fixed here at 5
--    minutes (inclusive: a claim exactly 5 minutes later succeeds); the only
--    parameter is the organization id. now() is the database clock at
--    transaction start. A claim is never released: a sync that fails or
--    aborts keeps its claim until the cooldown expires - bounded, never
--    permanent.
--
-- Idempotent: safe to apply twice. Apply as ONE transaction (the MCP
-- apply_migration mechanism supplies it; in the SQL editor wrap it in
-- begin/commit). Rollback: opportunity_sync_state_rollback.sql - but revert
-- the application code first (see the README).

create table if not exists public.opportunity_sync_state (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_started_at timestamp with time zone not null
);

alter table public.opportunity_sync_state enable row level security;

revoke all on table public.opportunity_sync_state from public;
revoke all on table public.opportunity_sync_state from anon;
revoke all on table public.opportunity_sync_state from authenticated;

create or replace function public.claim_opportunity_sync(p_organization_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  claimed boolean;
begin
  if p_organization_id is null
     or auth.uid() is null
     or not public.is_org_member(p_organization_id)
     or not public.organization_payment_active(p_organization_id) then
    return false;
  end if;

  insert into public.opportunity_sync_state as s (organization_id, last_started_at)
  values (p_organization_id, now())
  on conflict (organization_id) do update
    set last_started_at = excluded.last_started_at
    where s.last_started_at <= now() - interval '5 minutes'
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_opportunity_sync(uuid) from public;
revoke all on function public.claim_opportunity_sync(uuid) from anon;
grant execute on function public.claim_opportunity_sync(uuid) to authenticated;
