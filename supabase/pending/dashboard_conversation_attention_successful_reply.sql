-- STATUS: PENDING - NOT APPLIED TO PRODUCTION.
--
-- Phase 3 (W1): dashboard_conversation_attention classifies "waiting on a
-- reply" and "conversation went quiet" on the canonical evidence rule
-- (lib/conversations/waiting.ts): a conversation's newest message that is
-- either inbound, or outbound with status 'sent' or 'delivered'. A failed,
-- undelivered or queued send, or a logged internal note, is never a reply -
-- so a customer whose only reply failed stays "waiting", and never shows as
-- "went quiet".
--
-- Everything else is unchanged: the same signature and return type (so this
-- is a create or replace and existing grants are kept), open conversations
-- only, last_activity_at still from the true last message (any status),
-- the same ordering, the 48h quiet threshold, the lead-status condition and
-- the cap of 5 per kind.
--
-- Apply as one transaction, by a person (supabase/pending/README.md). Read
-- back md5(pg_get_functiondef(...)) afterwards. Rollback:
-- dashboard_conversation_attention_successful_reply_rollback.sql restores the
-- previous definition (md5 c36968b1a75e06f99fd7ad3a8f3c295e).

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
      -- Phase 3 (W1): classification evidence - inbound, or a successful outbound.
      evidence.direction as evidence_direction,
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
    left join lateral (
      select m.direction
      from public.messages m
      where m.conversation_id = c.id
        and m.organization_id = p_organization_id
        and (m.direction = 'inbound' or (m.direction = 'outbound' and m.status in ('sent', 'delivered')))
      order by m.created_at desc, m.id desc
      limit 1
    ) evidence on true
    where c.organization_id = p_organization_id
      and c.status = 'open'
  ),
  awaiting as (
    select conv.*, row_number() over (order by date_trunc('milliseconds', conv.last_activity_at) desc, conv.updated_at desc, conv.id) as rn
    from conv
    where conv.evidence_direction = 'inbound'
  ),
  abandoned as (
    select conv.*, row_number() over (order by date_trunc('milliseconds', conv.last_activity_at) desc, conv.updated_at desc, conv.id) as rn
    from conv
    left join public.leads l on l.id = conv.lead_id
    where conv.evidence_direction = 'outbound'
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
