-- Agency Command Center backend foundation: a minimal, flat agency-admin
-- allowlist and an explicit agency-client organization association.
--
-- There is exactly one implicit agency (Contractor Growth Co. itself) - no
-- `agencies` table is introduced. `agency_admins` has no grouping key, and
-- nothing in this product today requires supporting multiple independent
-- agencies, so a proper `agencies` table would be an unnecessary
-- abstraction. If a real multi-agency requirement ever appears, this can be
-- extended by adding an `agencies` table and an `agency_id` column to both
-- tables below without breaking anything here.

create table if not exists public.agency_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.agency_admins enable row level security;

-- A user may see whether THEY are an agency admin - never any other row, so
-- this table never becomes a way for a client-org user to enumerate who has
-- elevated access. No INSERT/UPDATE/DELETE policy exists: granting
-- agency-admin status is an out-of-band operation (direct database access),
-- not a self-service or in-app action - intentionally not built here.
create policy agency_admins_select_self on public.agency_admins
  for select
  using (user_id = auth.uid());

create table if not exists public.agency_organizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.agency_organizations enable row level security;

-- SECURITY DEFINER, matching the existing is_org_member/is_org_admin
-- convention: resolves auth.uid() internally rather than trusting any
-- caller-supplied identifier. Deliberately not organization-scoped (unlike
-- is_org_member(target_org_id)) - agency-admin status is global to the one
-- implicit agency, not per-client-organization.
create or replace function public.is_agency_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.agency_admins where user_id = auth.uid()
  );
$$;

-- Readable only by a verified agency admin - never by a client-organization
-- member, and this policy is the only way a session-authenticated caller can
-- ever see which organizations are agency clients. No INSERT/UPDATE/DELETE
-- policy: associating an organization with the agency is an out-of-band
-- operation for now, not a self-service or in-app action.
create policy agency_organizations_select on public.agency_organizations
  for select
  using (is_agency_admin());
