-- Phase 2E - Dashboard record-attention consolidation (PENDING).
--
-- One read-only function, dashboard_record_attention, that replaces the three
-- remaining capped reads inside getDashboardData (lib/dashboard/queries.ts)
-- on the Today page: leads (newest 500), appointments (latest start_at 200)
-- and estimates (500, no order). Everything getDashboardData derived from
-- those rows is computed here over the organization's complete data:
--
--   attention lists (at most 5 each, same order as before):
--     overdue_appointment, awaiting_confirmation, hot_lead, high_value_lead,
--     pending_estimate
--   the uncontacted_lead de-duplication set (hot or high-value active leads
--     that are the source of an open uncontacted_lead opportunity)
--   recent activity inputs (5 newest leads, 5 latest-start appointments)
--   overview counts and pipeline counts
--
-- Separate from dashboard_sql.sql (which is unchanged). Additive only: one new
-- function, no tables, no indexes, no RLS change.
--
-- Security model (same as dashboard_sql.sql):
--   * SECURITY INVOKER - RLS (is_org_member, the payment gate) stays the
--     authority for every table read here, exactly as for the PostgREST reads
--     this replaces.
--   * STABLE, read-only, fixed search_path.
--   * Every query filters organization_id = p_organization_id explicitly.
--   * EXECUTE revoked from PUBLIC/anon, granted to authenticated only.
--
-- Definitions are the existing TypeScript ones, unchanged: statuses,
-- thresholds (the high-value threshold is passed in from
-- HIGH_VALUE_THRESHOLD so it keeps one source of truth), "now" comparisons
-- and ordering. The only differences are (a) no row caps and (b) a
-- deterministic tie-breaker (id) where the old reads ordered by a single
-- timestamp, whose ties Postgres left undefined.
--
-- Parity: supabase/pending/scratch/validate-dashboard-sql.mjs.

begin;

create or replace function public.dashboard_record_attention(
  p_organization_id uuid,
  p_now timestamptz,
  p_high_value_threshold numeric
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    -- overdue_appointment: status 'scheduled' and start_at before now,
    -- latest start first (the old read's start_at DESC order).
    'overdue_appointments', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'start_at', x.start_at, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name) order by x.start_at desc, x.id)
      from (
        select a.id, a.title, a.start_at, ct.first_name, ct.last_name
        from public.appointments a
        left join public.contacts ct on ct.id = a.contact_id
        where a.organization_id = p_organization_id
          and a.status = 'scheduled'
          and a.start_at < p_now
        order by a.start_at desc, a.id
        limit 5
      ) x
    ), '[]'::jsonb),
    -- awaiting_confirmation: 'scheduled', a confirmation was requested, not
    -- confirmed, start_at now or later; same start_at DESC order.
    'awaiting_confirmation', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'confirmation_requested_at', x.confirmation_requested_at, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name) order by x.start_at desc, x.id)
      from (
        select a.id, a.title, a.start_at, a.confirmation_requested_at, ct.first_name, ct.last_name
        from public.appointments a
        left join public.contacts ct on ct.id = a.contact_id
        where a.organization_id = p_organization_id
          and a.status = 'scheduled'
          and a.confirmation_requested_at is not null
          and a.confirmed_at is null
          and a.start_at >= p_now
        order by a.start_at desc, a.id
        limit 5
      ) x
    ), '[]'::jsonb),
    -- hot_lead: temperature 'hot', active status; newest lead first.
    'hot_leads', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'service', x.service, 'estimated_value', x.estimated_value, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name) order by x.created_at desc, x.id)
      from (
        select l.id, l.service, l.estimated_value, l.created_at, ct.first_name, ct.last_name
        from public.leads l
        left join public.contacts ct on ct.id = l.contact_id
        where l.organization_id = p_organization_id
          and l.temperature = 'hot'
          and l.status in ('new', 'contacted', 'qualified', 'appointment', 'estimate')
        order by l.created_at desc, l.id
        limit 5
      ) x
    ), '[]'::jsonb),
    -- high_value_lead: not hot, active, estimated_value at or above the
    -- threshold; newest first.
    'high_value_leads', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'service', x.service, 'estimated_value', x.estimated_value, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name) order by x.created_at desc, x.id)
      from (
        select l.id, l.service, l.estimated_value, l.created_at, ct.first_name, ct.last_name
        from public.leads l
        left join public.contacts ct on ct.id = l.contact_id
        where l.organization_id = p_organization_id
          and l.temperature is distinct from 'hot'
          and l.status in ('new', 'contacted', 'qualified', 'appointment', 'estimate')
          and l.estimated_value is not null
          and l.estimated_value >= p_high_value_threshold
        order by l.created_at desc, l.id
        limit 5
      ) x
    ), '[]'::jsonb),
    -- pending_estimate: any lead with at least one 'sent' estimate; newest
    -- lead first.
    'pending_estimate_leads', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'service', x.service, 'estimated_value', x.estimated_value, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name) order by x.created_at desc, x.id)
      from (
        select l.id, l.service, l.estimated_value, l.created_at, ct.first_name, ct.last_name
        from public.leads l
        left join public.contacts ct on ct.id = l.contact_id
        where l.organization_id = p_organization_id
          and exists (
            select 1 from public.estimates e
            where e.organization_id = p_organization_id and e.lead_id = l.id and e.status = 'sent'
          )
        order by l.created_at desc, l.id
        limit 5
      ) x
    ), '[]'::jsonb),
    -- The uncontacted_lead de-duplication set, restricted to the leads it can
    -- ever matter for: sources of open uncontacted_lead opportunities.
    'uncontacted_dedup_lead_ids', coalesce((
      select jsonb_agg(distinct l.id)
      from public.opportunities o
      join public.leads l on l.id = o.source_entity_id and l.organization_id = p_organization_id
      where o.organization_id = p_organization_id
        and o.status = 'open'
        and o.type = 'uncontacted_lead'
        and l.status in ('new', 'contacted', 'qualified', 'appointment', 'estimate')
        and (l.temperature = 'hot' or (l.estimated_value is not null and l.estimated_value >= p_high_value_threshold))
    ), '[]'::jsonb),
    -- Recent activity inputs: the 5 newest leads, and the 5 appointments with
    -- the latest start_at (what the old start_at DESC read's first 5 were).
    'recent_leads', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'service', x.service, 'created_at', x.created_at, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name) order by x.created_at desc, x.id)
      from (
        select l.id, l.service, l.created_at, ct.first_name, ct.last_name
        from public.leads l
        left join public.contacts ct on ct.id = l.contact_id
        where l.organization_id = p_organization_id
        order by l.created_at desc, l.id
        limit 5
      ) x
    ), '[]'::jsonb),
    'recent_appointments', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'created_at', x.created_at, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name) order by x.start_at desc, x.id)
      from (
        select a.id, a.title, a.start_at, a.created_at, ct.first_name, ct.last_name
        from public.appointments a
        left join public.contacts ct on ct.id = a.contact_id
        where a.organization_id = p_organization_id
        order by a.start_at desc, a.id
        limit 5
      ) x
    ), '[]'::jsonb),
    -- Overview and pipeline counts.
    'new_leads', (select count(*) from public.leads l where l.organization_id = p_organization_id and l.status = 'new'),
    'open_leads', (select count(*) from public.leads l where l.organization_id = p_organization_id and l.status in ('new', 'contacted', 'qualified', 'appointment', 'estimate')),
    'upcoming_appointments', (
      select count(*) from public.appointments a
      where a.organization_id = p_organization_id and a.status in ('scheduled', 'confirmed') and a.start_at >= p_now
    ),
    'pending_estimates', (select count(*) from public.estimates e where e.organization_id = p_organization_id and e.status = 'sent'),
    'pipeline', (
      select jsonb_build_object(
        'new', count(*) filter (where l.status = 'new'),
        'contacted', count(*) filter (where l.status = 'contacted'),
        'qualified', count(*) filter (where l.status = 'qualified'),
        'appointment', count(*) filter (where exists (
          select 1 from public.appointments a
          where a.organization_id = p_organization_id and a.lead_id = l.id and a.status in ('scheduled', 'confirmed', 'completed')
        )),
        'estimate', count(*) filter (where exists (
          select 1 from public.estimates e
          where e.organization_id = p_organization_id and e.lead_id = l.id and e.status = 'sent'
        )),
        'won', count(*) filter (where l.status = 'won')
      )
      from public.leads l
      where l.organization_id = p_organization_id
    )
  );
$$;

revoke all on function public.dashboard_record_attention(uuid, timestamptz, numeric) from public;
revoke all on function public.dashboard_record_attention(uuid, timestamptz, numeric) from anon;
grant execute on function public.dashboard_record_attention(uuid, timestamptz, numeric) to authenticated;

commit;
