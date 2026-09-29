-- Phase 2D - Dashboard SQL summary + attention consolidation (PENDING).
--
-- Three read-only aggregate functions for app/(app)/today/page.tsx, replacing
-- the Dashboard's whole-table reads (appointments 1,000, estimates 1,000,
-- jobs 1,000, invoices 1,000, customer_payments 5,000, conversations 500,
-- messages 2,000, review/referral requests 1,000 each, open-lead values
-- 10,000) that were fetched only to be counted or summed in TypeScript.
--
-- Additive only: three new functions, nothing altered or dropped, no tables,
-- no indexes, no RLS change.
--
-- Security model:
--   * SECURITY INVOKER - every read runs as the calling user, so the
--     existing RLS policies (is_org_member, the payment gate) stay the
--     authority exactly as they are for the PostgREST reads these replace.
--   * STABLE, read-only, fixed search_path.
--   * Every query also filters organization_id = p_organization_id
--     explicitly, mirroring the .eq("organization_id", ...) of each read it
--     replaces.
--   * EXECUTE is revoked from PUBLIC/anon and granted to authenticated only.
--
-- Definitions are the existing TypeScript definitions, reproduced exactly
-- (lib/money/snapshot.ts computeMoneySnapshot, lib/invoices/summary.ts
-- summarizeInvoiceMoney, lib/appointments/queries.ts summarizeAppointments,
-- lib/leads/queries.ts getHotLeadCount / OPEN_LEAD_STATUSES,
-- lib/bi/queries.ts getLeadAndPipelineMetrics, lib/dashboard/queries.ts
-- awaiting_reply / abandoned_conversation, lib/briefing/queries.ts), with
-- one deliberate difference: no row caps. Everything that is counted or
-- summed covers the organization's complete data; lists that the UI
-- displays as "top N" stay bounded (LIMIT 5).
--
-- Time semantics stay in TypeScript: the caller passes the day boundaries it
-- already uses (the server-local calendar day of summarizeAppointments /
-- briefing isToday), the invoicing go-live cutoff, "now" and "seven days
-- ago". Invoice overdue needs the organization-timezone "today", so
-- dashboard_summary returns open-invoice balances grouped by due date and
-- TypeScript applies the unchanged isOverdue rule.
--
-- Parity with the TypeScript it replaces is proved by
-- supabase/pending/scratch/validate-dashboard-sql.mjs.

begin;

-- ---------------------------------------------------------------------------
-- 1. dashboard_summary: the Dashboard's primary figures.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_summary(
  p_organization_id uuid,
  p_day_start timestamptz,
  p_day_end timestamptz,
  p_invoicing_live_at timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with
  leads_agg as (
    select
      count(*) filter (where l.temperature = 'hot') as hot_lead_count,
      coalesce(sum(coalesce(l.estimated_value, 0)) filter (where l.status in ('new', 'contacted', 'qualified', 'appointment', 'estimate')), 0) as pipeline_value
    from public.leads l
    where l.organization_id = p_organization_id
  ),
  appointments_agg as (
    select count(*) as appointments_today
    from public.appointments a
    where a.organization_id = p_organization_id
      and a.start_at >= p_day_start
      and a.start_at < p_day_end
  ),
  estimates_agg as (
    select
      count(*) filter (where e.status = 'sent') as quotes_out_count,
      coalesce(sum(coalesce(e.amount, 0)) filter (where e.status = 'sent'), 0) as quotes_out_value,
      count(*) filter (where e.status = 'accepted' and not e.has_job) as ready_to_schedule_count,
      coalesce(sum(coalesce(e.amount, 0)) filter (where e.status = 'accepted' and not e.has_job), 0) as ready_to_schedule_value
    from (
      select
        e.status,
        e.amount,
        exists (select 1 from public.jobs j where j.organization_id = p_organization_id and j.estimate_id = e.id) as has_job
      from public.estimates e
      where e.organization_id = p_organization_id
    ) e
  ),
  jobs_agg as (
    select
      count(*) filter (where j.status in ('scheduled', 'in_progress')) as won_not_finished_count,
      coalesce(sum(coalesce(j.amount, 0)) filter (where j.status in ('scheduled', 'in_progress')), 0) as won_not_finished_value
    from public.jobs j
    where j.organization_id = p_organization_id
  ),
  invoices_agg as (
    select
      count(*) filter (where i.status in ('sent', 'partially_paid', 'paid')) as invoiced_count,
      coalesce(sum(i.total) filter (where i.status in ('sent', 'partially_paid', 'paid')), 0) as invoiced,
      count(*) filter (where i.status in ('sent', 'partially_paid')) as outstanding_count,
      coalesce(sum(i.balance_due) filter (where i.status in ('sent', 'partially_paid')), 0) as outstanding,
      count(*) filter (where i.status = 'draft') as draft_count
    from public.invoices i
    where i.organization_id = p_organization_id
  ),
  open_due as (
    select coalesce(jsonb_agg(jsonb_build_object('due_date', b.due_date, 'balance_due', b.balance_due, 'count', b.invoice_count) order by b.due_date), '[]'::jsonb) as open_due_buckets
    from (
      select i.due_date, sum(i.balance_due) as balance_due, count(*) as invoice_count
      from public.invoices i
      where i.organization_id = p_organization_id
        and i.status in ('sent', 'partially_paid')
        and i.due_date is not null
      group by i.due_date
    ) b
  ),
  payments_agg as (
    select
      coalesce(sum(p.amount), 0) as collected,
      count(*) filter (where p.amount > 0) as payment_count
    from public.customer_payments p
    where p.organization_id = p_organization_id
  ),
  not_yet_invoiced as (
    select
      count(*) as not_yet_invoiced_count,
      coalesce(sum(j.amount) filter (where j.amount is not null), 0) as not_yet_invoiced_known_value,
      count(*) filter (where j.amount is null) as not_yet_invoiced_unknown_count
    from public.jobs j
    where j.organization_id = p_organization_id
      and j.status = 'completed'
      and coalesce(j.completed_at, j.created_at) >= p_invoicing_live_at
      and not exists (
        select 1 from public.invoices i
        where i.organization_id = p_organization_id and i.job_id = j.id and i.status <> 'void'
      )
  )
  select jsonb_build_object(
    'hot_lead_count', leads_agg.hot_lead_count,
    'pipeline_value', leads_agg.pipeline_value,
    'appointments_today', appointments_agg.appointments_today,
    'quotes_out_count', estimates_agg.quotes_out_count,
    'quotes_out_value', estimates_agg.quotes_out_value,
    'ready_to_schedule_count', estimates_agg.ready_to_schedule_count,
    'ready_to_schedule_value', estimates_agg.ready_to_schedule_value,
    'won_not_finished_count', jobs_agg.won_not_finished_count,
    'won_not_finished_value', jobs_agg.won_not_finished_value,
    'invoiced', invoices_agg.invoiced,
    'invoiced_count', invoices_agg.invoiced_count,
    'collected', payments_agg.collected,
    'payment_count', payments_agg.payment_count,
    'outstanding', invoices_agg.outstanding,
    'outstanding_count', invoices_agg.outstanding_count,
    'open_due_buckets', open_due.open_due_buckets,
    'draft_count', invoices_agg.draft_count,
    'not_yet_invoiced_count', not_yet_invoiced.not_yet_invoiced_count,
    'not_yet_invoiced_known_value', not_yet_invoiced.not_yet_invoiced_known_value,
    'not_yet_invoiced_unknown_count', not_yet_invoiced.not_yet_invoiced_unknown_count
  )
  from leads_agg, appointments_agg, estimates_agg, jobs_agg, invoices_agg, open_due, payments_agg, not_yet_invoiced;
$$;

-- ---------------------------------------------------------------------------
-- 2. dashboard_conversation_attention: awaiting_reply and
--    abandoned_conversation (lib/dashboard/queries.ts getDashboardData),
--    at most 5 of each, in the same order.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_conversation_attention(
  p_organization_id uuid,
  p_now timestamptz
)
returns table (
  kind text,
  item_position integer,
  conversation_id uuid,
  contact_first_name text,
  contact_last_name text,
  last_activity_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with conv as (
    select
      c.id,
      c.contact_id,
      c.lead_id,
      c.updated_at,
      last_message.direction as last_direction,
      -- attachLastMessages: the last message's time when it is later than
      -- the conversation's updated_at, else updated_at.
      greatest(last_message.created_at, c.updated_at) as last_activity_at
    from public.conversations c
    left join lateral (
      select m.direction, m.created_at
      from public.messages m
      where m.conversation_id = c.id
        and m.organization_id = p_organization_id
      order by m.created_at desc, m.id desc
      limit 1
    ) last_message on true
    where c.organization_id = p_organization_id
      and c.status = 'open'
  ),
  awaiting as (
    select conv.*, row_number() over (order by date_trunc('milliseconds', conv.last_activity_at) desc, conv.updated_at desc, conv.id) as rn
    from conv
    where conv.last_direction = 'inbound'
  ),
  abandoned as (
    select conv.*, row_number() over (order by date_trunc('milliseconds', conv.last_activity_at) desc, conv.updated_at desc, conv.id) as rn
    from conv
    left join public.leads l on l.id = conv.lead_id
    where conv.last_direction = 'outbound'
      and date_trunc('milliseconds', conv.last_activity_at) <= p_now - interval '48 hours'
      and (l.id is null or l.status in ('new', 'contacted', 'qualified'))
  ),
  picked as (
    select 'awaiting_reply'::text as kind, rn, id, contact_id, last_activity_at from awaiting where rn <= 5
    union all
    select 'abandoned_conversation'::text as kind, rn, id, contact_id, last_activity_at from abandoned where rn <= 5
  )
  select picked.kind, picked.rn::integer, picked.id, ct.first_name, ct.last_name, picked.last_activity_at
  from picked
  left join public.contacts ct on ct.id = picked.contact_id
  order by picked.kind desc, picked.rn;
$$;

-- ---------------------------------------------------------------------------
-- 3. dashboard_briefing: the daily-briefing and end-of-day inputs
--    (lib/briefing/queries.ts), bounded lists + uncapped counts.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_briefing(
  p_organization_id uuid,
  p_day_start timestamptz,
  p_day_end timestamptz,
  p_seven_days_ago timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'appointments_today', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'start_at', x.start_at, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name, 'has_contact', x.has_contact) order by x.start_at, x.id)
      from (
        select a.id, a.title, a.start_at, ct.first_name, ct.last_name, ct.id is not null as has_contact
        from public.appointments a
        left join public.contacts ct on ct.id = a.contact_id
        where a.organization_id = p_organization_id
          and a.start_at >= p_day_start and a.start_at < p_day_end
          and a.status in ('scheduled', 'confirmed')
        order by a.start_at, a.id
        limit 5
      ) x
    ), '[]'::jsonb),
    'estimates_awaiting', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'amount', x.amount, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name, 'has_contact', x.has_contact) order by x.created_at desc, x.id)
      from (
        select e.id, e.title, e.amount, e.created_at, ct.first_name, ct.last_name, ct.id is not null as has_contact
        from public.estimates e
        left join public.contacts ct on ct.id = e.contact_id
        where e.organization_id = p_organization_id and e.status = 'sent'
        order by e.created_at desc, e.id
        limit 5
      ) x
    ), '[]'::jsonb),
    'jobs_recently_completed', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'amount', x.amount, 'contact_first_name', x.first_name, 'contact_last_name', x.last_name, 'has_contact', x.has_contact) order by x.created_at desc, x.id)
      from (
        select j.id, j.title, j.amount, j.created_at, ct.first_name, ct.last_name, ct.id is not null as has_contact
        from public.jobs j
        left join public.contacts ct on ct.id = j.contact_id
        where j.organization_id = p_organization_id
          and j.status = 'completed'
          and j.completed_at is not null
          and date_trunc('milliseconds', j.completed_at) >= p_seven_days_ago
        order by j.created_at desc, j.id
        limit 5
      ) x
    ), '[]'::jsonb),
    -- Intentional change (approved in Phase 2D): the previous TypeScript read
    -- review/referral requests with no ORDER BY, so their order - and, with
    -- more than five responded requests, WHICH five were shown - was
    -- undefined. They are now deterministic: created_at ASC, id ASC as the
    -- tie-breaker (oldest unconfirmed response first).
    'responded_reviews', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status, 'job_id', x.job_id) order by x.created_at, x.id)
      from (
        select r.id, r.status, r.job_id, r.created_at
        from public.review_requests r
        where r.organization_id = p_organization_id and r.status = 'responded'
        order by r.created_at, r.id
        limit 5
      ) x
    ), '[]'::jsonb),
    'responded_referrals', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status, 'job_id', x.job_id) order by x.created_at, x.id)
      from (
        select r.id, r.status, r.job_id, r.created_at
        from public.referral_requests r
        where r.organization_id = p_organization_id and r.status = 'responded'
        order by r.created_at, r.id
        limit 5
      ) x
    ), '[]'::jsonb),
    'appointments_booked_today', (
      select count(*) from public.appointments a
      where a.organization_id = p_organization_id and a.created_at >= p_day_start and a.created_at < p_day_end
    ),
    'estimates_sent_today', (
      select count(*) from public.estimates e
      where e.organization_id = p_organization_id and e.sent_at is not null and e.sent_at >= p_day_start and e.sent_at < p_day_end
    ),
    'estimates_sent_today_value', (
      select coalesce(sum(coalesce(e.amount, 0)), 0) from public.estimates e
      where e.organization_id = p_organization_id and e.sent_at is not null and e.sent_at >= p_day_start and e.sent_at < p_day_end
    ),
    'jobs_won_or_completed_today', (
      select count(*) from public.jobs j
      where j.organization_id = p_organization_id
        and ((j.status <> 'cancelled' and j.created_at >= p_day_start and j.created_at < p_day_end)
          or (j.status = 'completed' and j.completed_at is not null and j.completed_at >= p_day_start and j.completed_at < p_day_end))
    ),
    'jobs_won_or_completed_today_value', (
      select coalesce(sum(coalesce(j.amount, 0)), 0) from public.jobs j
      where j.organization_id = p_organization_id
        and ((j.status <> 'cancelled' and j.created_at >= p_day_start and j.created_at < p_day_end)
          or (j.status = 'completed' and j.completed_at is not null and j.completed_at >= p_day_start and j.completed_at < p_day_end))
    ),
    'ai_escalations_count', (
      select count(*) from public.conversations c
      where c.organization_id = p_organization_id and c.status = 'open' and c.ai_enabled = false
    ),
    'hot_lead_count', (
      select count(*) from public.leads l
      where l.organization_id = p_organization_id and l.temperature = 'hot'
    )
  );
$$;

revoke all on function public.dashboard_summary(uuid, timestamptz, timestamptz, timestamptz) from public;
revoke all on function public.dashboard_summary(uuid, timestamptz, timestamptz, timestamptz) from anon;
grant execute on function public.dashboard_summary(uuid, timestamptz, timestamptz, timestamptz) to authenticated;

revoke all on function public.dashboard_conversation_attention(uuid, timestamptz) from public;
revoke all on function public.dashboard_conversation_attention(uuid, timestamptz) from anon;
grant execute on function public.dashboard_conversation_attention(uuid, timestamptz) to authenticated;

revoke all on function public.dashboard_briefing(uuid, timestamptz, timestamptz, timestamptz) from public;
revoke all on function public.dashboard_briefing(uuid, timestamptz, timestamptz, timestamptz) from anon;
grant execute on function public.dashboard_briefing(uuid, timestamptz, timestamptz, timestamptz) to authenticated;

commit;
