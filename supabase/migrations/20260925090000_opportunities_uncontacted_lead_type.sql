-- Pass 5C, Batch 2: adds the uncontacted_lead opportunity type - a lead
-- that has existed at least 24 hours with no durable Trackpr evidence of a
-- successfully sent outbound message (no inbound reply, no outbound message
-- with status 'sent'/'delivered'), while the organization currently has
-- working, eligible automation (live, paid, unpaused, instant-lead-followup
-- enabled).
--
-- This is explicitly "no recorded outbound contact" per Trackpr's own
-- evidence, not a claim that the customer was never reached by any means -
-- see lib/opportunities/detect.ts's detectUncontactedLeads for the full,
-- documented evidence hierarchy and exclusion list (opted-out contacts,
-- ineligible organizations, leads that already progressed past 'new', any
-- inbound reply, any successful outbound send).
--
-- Closes the one open question from the Pass 5C Batch 2 read-only audit:
-- live inspection of the active n8n lead_created_followup workflow
-- (node-by-node trace, real execution evidence via blocked_reason implying
-- a real should_send:true) confirmed the instant-lead-followup automation
-- is genuinely capable of sending, so "no successful outbound evidence" is
-- a real, actionable signal rather than a universal, by-design constant.
--
-- Same additive pattern as every prior opportunities_type_check widening in
-- this codebase (20260925050000, 20260925080000): drop and recreate (no
-- ALTER CHECK in Postgres), using the exact live constraint name, widening
-- only - no existing row can ever violate the new constraint. source_entity_type
-- is already 'lead' in the existing CHECK (used by qualified_lead_unbooked),
-- so nothing there needs to change. No new table, column, index, RLS
-- policy, or trigger - the existing opportunities_select/insert/update/delete
-- policies, the payment-gate restrictive policy, the partial unique dedup
-- index, and the updated_at trigger already cover any type value.

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
    'uncontacted_lead'
  ));
