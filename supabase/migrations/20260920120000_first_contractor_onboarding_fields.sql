-- First Contractor Onboarding + Internal Client Setup System.
--
-- Audit confirmed the business/operations/communications/reputation model is
-- almost entirely already present on organizations/notification_settings.
-- The only genuinely missing fields, all additive and nullable (or safely
-- defaulted), are added here - no table is created, no existing column is
-- renamed or altered in type, and RLS is unaffected since these columns
-- belong to tables already covered by existing is_org_admin()/is_org_member()
-- policies (organizations_select/update, notification_settings_select/
-- insert/update) - a new column automatically inherits its table's existing
-- row-level policies.
--
-- facebook_url: mirrors review_url's existing shape/precedent exactly - a
-- second, optional reputation link.
-- emergency_service/after_hours_handling/estimate_process: operational facts
-- about the business that the AI/agency onboarding checklist needs and that
-- have no existing home (distinct from business_hours, which is only the
-- weekly schedule, and from ai_settings.emergency_instructions, which is AI
-- behavior text, not a business fact).
-- lead_sources: a fixed, small set of channels (validated at the app layer
-- against LEAD_SOURCE_OPTIONS) describing where this contractor's leads
-- already come from - informational context for onboarding/agency setup,
-- not the same as leads.source (which is per-lead runtime attribution).
-- escalation_contact_name: notification_settings already has
-- notification_phone/notification_email and a notify_on_ai_escalation
-- toggle - this adds only the missing "whose name is this" field rather than
-- duplicating phone/email columns that already exist for this exact purpose.

alter table public.organizations
  add column if not exists facebook_url text,
  add column if not exists emergency_service boolean not null default false,
  add column if not exists after_hours_handling text,
  add column if not exists estimate_process text,
  add column if not exists lead_sources text[];

alter table public.notification_settings
  add column if not exists escalation_contact_name text;
