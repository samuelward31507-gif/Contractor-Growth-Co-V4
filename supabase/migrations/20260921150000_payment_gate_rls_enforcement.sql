-- Payment Gate V1, part 2: enforce payment_status at the database layer.
--
-- Launch Blocker #1 from the 2026-09-21 pre-launch audit: the payment gate
-- added in 20260921120000_organization_payment_status.sql is only checked
-- in app/(app)/layout.tsx. Next.js Server Actions are independent POST
-- endpoints, not re-gated by their parent layout, and no RLS policy
-- anywhere inspects payment_status - so an authenticated user belonging to
-- an unpaid organization can call any org-scoped Server Action directly, or
-- call the Supabase REST API with their own session JWT, and fully read/
-- write their organization's leads/contacts/jobs/etc. despite never having
-- paid. This migration closes that at the one place that can't be bypassed
-- by any client: the database itself.
--
-- DESIGN: additive RESTRICTIVE policies, not a change to is_org_member()/
-- is_org_admin() or any existing policy.
--
-- Postgres RLS policies are either PERMISSIVE (the default - multiple
-- permissive policies for the same command are OR'd together) or
-- RESTRICTIVE (AND'd on top of whatever the permissive policies already
-- allow). Every existing policy in this schema is permissive and keeps
-- exactly its current behavior, untouched. This migration adds exactly one
-- new RESTRICTIVE policy per gated table, requiring payment_status =
-- 'active' in addition to whatever the existing is_org_member()/
-- is_org_admin() permissive policy already required. This was chosen over
-- editing is_org_member()/is_org_admin() themselves (or each of the ~50
-- existing policies individually) for two reasons: (1) is_org_member() is
-- also what resolves an organization's own membership/payment_status for
-- the onboarding and payment-required screens - making it payment-aware
-- would make an unpaid organization unable to read its own payment_status,
-- a chicken-and-egg deadlock the audit explicitly warned against; (2) a
-- purely additive policy is zero-risk to every existing policy's own,
-- already-reviewed logic - there is nothing to regress.
--
-- WHICH TABLES ARE GATED, AND WHY organizations/organization_members/
-- service_areas ARE NOT:
--
-- Gated (ordinary Trackpr application/business data - the actual CRM and
-- automation resources the business rule is about): ai_interactions,
-- ai_settings, appointments, audit_log, automation_events,
-- automation_incidents, automation_settings, booking_settings,
-- business_hours, contacts, conversations, estimates, jobs, leads,
-- messages, notification_settings, referral_requests, review_requests,
-- services, workflow_executions.
--
-- Intentionally NOT gated:
--   - organizations, organization_members: an organization must remain
--     able to authenticate, exist, read its own name/payment_status (this
--     is literally how getUserOrganization() decides whether to render the
--     payment-required screen), and its owner must remain able to update
--     its own profile columns (app/onboarding/actions.ts's createOrganization
--     writes owner_name/trade/phone here immediately after
--     bootstrap_organization(), before any payment exists) and start
--     Stripe Checkout. Gating these would make an unpaid organization
--     invisible to itself and permanently stuck before it could ever pay.
--   - service_areas: app/onboarding/actions.ts's createOrganization also
--     inserts the first service_areas row in that same pre-payment
--     bootstrap step (same action, same request, before checkout). Gating
--     it would silently break that write. This is a narrow, deliberate
--     exception - service area names are not customer PII and carry none
--     of the automation-triggering risk that leads/contacts/conversations
--     do.
--   - automation_health_check_runs: has no organization_id column at all
--     (a deliberately global, cross-tenant health signal per
--     20260919160000_automation_health_and_alerting.sql) - there is no
--     organization to gate it by.
--
-- RECURSION: organization_payment_active() below is STABLE SECURITY
-- DEFINER with a restricted search_path, the exact same pattern already
-- used by is_org_member()/is_org_admin() to read organization_members
-- without triggering that table's own RLS. No table in this schema has
-- FORCE ROW LEVEL SECURITY set, so a SECURITY DEFINER function owned by
-- the table owner (postgres) bypasses RLS on the tables it queries
-- internally, exactly as is_org_member()/is_org_admin() already rely on.
-- organization_payment_active() only ever queries public.organizations by
-- primary key - it cannot recurse into itself or into any gated table.
--
-- SERVICE ROLE / STRIPE / N8N: the service_role Postgres role has BYPASSRLS
-- and ignores every policy (permissive and restrictive) regardless of
-- payment_status. The Stripe webhook's activation write (which itself only
-- ever touches organizations.payment_status, not a gated table),
-- lib/supabase/service.ts-based cron/automation routes, and the n8n
-- callback route are therefore entirely unaffected by this migration.
--
-- KNOWN REMAINING EXPOSURE (documented, not fixed by this migration): a
-- handful of user-invocable SECURITY DEFINER RPCs (e.g. merge_contacts,
-- acknowledge_automation_incident, resolve_automation_incident) perform
-- their own writes to gated tables internally and therefore bypass RLS the
-- same way is_org_member() does - they were already independently
-- authorization-checked (is_org_admin()/is_org_member()) before this
-- migration, but not payment-status-checked. Retrofitting every such RPC
-- was out of scope for this fix (see the accompanying report) since it
-- risks touching automation/service-role code paths this task was
-- explicitly told not to change; it remains a follow-up item.

create or replace function public.organization_payment_active(target_org_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.organizations o
    where o.id = target_org_id
      and o.payment_status = 'active'
  );
$$;

do $$
declare
  gated_table text;
  gated_tables text[] := array[
    'ai_interactions', 'ai_settings', 'appointments', 'audit_log',
    'automation_events', 'automation_incidents', 'automation_settings',
    'booking_settings', 'business_hours', 'contacts', 'conversations',
    'estimates', 'jobs', 'leads', 'messages', 'notification_settings',
    'referral_requests', 'review_requests', 'services', 'workflow_executions'
  ];
begin
  foreach gated_table in array gated_tables loop
    execute format(
      'drop policy if exists %I on public.%I',
      gated_table || '_payment_active', gated_table
    );
    execute format(
      'create policy %I on public.%I as restrictive for all to public using (public.organization_payment_active(organization_id)) with check (public.organization_payment_active(organization_id))',
      gated_table || '_payment_active', gated_table
    );
  end loop;
end $$;
