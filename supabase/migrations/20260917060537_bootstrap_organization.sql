-- Onboarding bootstrap RPC.
--
-- organizations/organization_members RLS is intentionally INSERT-less from
-- the client: a brand-new user has no organization_members row yet, so
-- organization_members_insert's is_org_admin(organization_id) check can
-- never be satisfied by a direct client insert. This SECURITY DEFINER
-- function is the only sanctioned way to create the first organization and
-- owner membership for a user; it derives identity exclusively from
-- auth.uid() and hardcodes the role, so it cannot be used to join an
-- existing organization or self-assign a role.
create or replace function public.bootstrap_organization(org_name text)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_org_id uuid;
  v_name text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if exists (
    select 1 from public.organization_members
    where user_id = v_user_id
  ) then
    raise exception 'User already belongs to an organization';
  end if;

  v_name := trim(org_name);
  if v_name is null or length(v_name) = 0 then
    raise exception 'Organization name is required';
  end if;

  insert into public.organizations (name)
  values (v_name)
  returning id into v_org_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org_id, v_user_id, 'owner');

  return v_org_id;
end;
$$;

revoke all on function public.bootstrap_organization(text) from public;
revoke all on function public.bootstrap_organization(text) from anon;
grant execute on function public.bootstrap_organization(text) to authenticated;
