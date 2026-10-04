-- Rollback for dashboard_conversation_attention_successful_reply.sql. Run as
-- one transaction, by a person, only if the forward script must be undone.
-- Restores the exact previous definition (the newest message of any status
-- decides waiting vs went quiet) - read back md5(pg_get_functiondef(...)) =
-- c36968b1a75e06f99fd7ad3a8f3c295e afterwards. Same signature, so grants are
-- untouched; the function is read-only and owns no data. The application
-- code works with either definition.

begin;

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

commit;
