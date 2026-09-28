-- Canonical Opportunity Intelligence Layer, Part 1 (schema): two additive
-- changes, both following this codebase's own established patterns exactly.
--
-- 1. Two new opportunity types, widening the existing opportunities_type_check
--    the same way every prior opportunity-type addition has (see
--    20260925110000_opportunities_accepted_estimate_no_job_type.sql for the
--    identical pattern). These replace the Attention Engine's own
--    non-persisted hot_lead/high_value_lead/pending_estimate conditions with
--    real, persisted Opportunity rows, closing the long-standing duplication
--    between the Attention Engine and the Opportunity Engine (see
--    lib/opportunities/detect.ts's own header comment history):
--
--      active_lead_signal - a lead marked hot or at/above the existing
--        high-value threshold, SOURCED FROM THE SAME leads.temperature/
--        estimated_value fields the old hot_lead/high_value_lead attention
--        kinds already read - never a new signal, never a computed score.
--        Detected only for leads NOT already covered by a more specific
--        opportunity type (qualified_lead_unbooked, uncontacted_lead,
--        completed_appointment_no_estimate, accepted_estimate_no_job) for
--        the same lead - where a more specific type already exists, the
--        lead's temperature/value becomes supporting context on THAT
--        opportunity instead of a second, duplicate row.
--
--      pending_estimate - a lead with a real sent (not yet accepted/
--        declined/expired/cancelled) estimate - the same real-world
--        condition the old pending_estimate attention kind already read
--        (estimates.status = 'sent'). Same duplication-avoidance rule as
--        active_lead_signal above.
--
--    source_entity_type is unchanged - both new types source from 'lead',
--    already permitted.
--
-- 2. opportunities.resolution_reason: the minimum additive field identified
--    by the approved Opportunity Intelligence Model design as necessary for
--    future outcome/learning instrumentation, without any event-sourcing
--    architecture. Mirrors the existing opportunities_check constraint's own
--    exact shape (resolved_at IS NULL OR status IN ('resolved','dismissed'))
--    for the identical reason - a resolution reason only ever makes sense
--    once an opportunity has actually closed. Nullable, no backfill required
--    (existing closed rows simply have no recorded reason, which is
--    accurate - the concept did not exist when they closed).

alter table public.opportunities
  drop constraint if exists opportunities_type_check;

alter table public.opportunities
  add constraint opportunities_type_check
  check (type in (
    'qualified_lead_unbooked',
    'stale_estimate',
    'completed_appointment_no_estimate',
    'dormant_customer',
    'no_show',
    'completed_job_no_referral_request',
    'completed_job_no_review_request',
    'cancelled_appointment_no_rebooking',
    'uncontacted_lead',
    'accepted_estimate_no_job',
    'active_lead_signal',
    'pending_estimate'
  ));

alter table public.opportunities
  add column if not exists resolution_reason text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_resolution_reason_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_resolution_reason_check
      check (resolution_reason is null or resolution_reason in ('condition_no_longer_true', 'dismissed', 'lost'));
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_resolution_reason_requires_closed_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_resolution_reason_requires_closed_check
      check (resolution_reason is null or status in ('resolved', 'dismissed'));
  end if;
end $$;
