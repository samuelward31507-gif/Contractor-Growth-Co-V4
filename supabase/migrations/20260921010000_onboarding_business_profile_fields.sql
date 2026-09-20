-- First Client Onboarding V1.
--
-- Per audit: Trackpr already has organizations.name/phone/email/website,
-- business_hours, services, service_areas, ai_settings, sms_phone_number,
-- automation_mode, and lead_intake_token - all reused unchanged by the
-- onboarding flow. The only two fields genuinely missing for Onboarding
-- Step 1 ("Business") are an owner/contact name and a trade - collected on
-- the marketing site's Get Started form today but never persisted into
-- Trackpr itself. Both are purely additive and nullable: existing
-- organizations are unaffected, no other column or table is touched.

alter table public.organizations
  add column if not exists owner_name text;

alter table public.organizations
  add column if not exists trade text;
