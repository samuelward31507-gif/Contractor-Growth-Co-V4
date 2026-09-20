-- First-Client Lead Capture V1.
--
-- The missing connection identified between an external lead source (a
-- contractor's own website form, a lead-gen platform's webhook, Zapier/Make,
-- etc.) and Trackpr: there was no ingress endpoint at all, and no way to
-- identify which organization an inbound lead belongs to without trusting a
-- client-supplied organization_id (unsafe - see
-- app/api/leads/capture/[token]/route.ts's own comment). This mirrors the
-- exact pattern organizations.sms_phone_number already uses for the inbound
-- SMS webhook: a unique per-organization value in the request itself, looked
-- up server-side to resolve the organization - never trusted as an
-- organization id directly.
--
-- Every organization (existing and new) gets a real, random, unguessable
-- token - there is no meaningful "unconfigured" state to preserve here (this
-- feature did not exist before this migration), so a blanket backfill is
-- safe and does not change any existing behavior.

alter table public.organizations
  add column if not exists lead_intake_token text;

update public.organizations
  set lead_intake_token = encode(gen_random_bytes(24), 'hex')
  where lead_intake_token is null;

alter table public.organizations
  alter column lead_intake_token set default (encode(gen_random_bytes(24), 'hex'));

alter table public.organizations
  alter column lead_intake_token set not null;

create unique index if not exists organizations_lead_intake_token_unique
  on public.organizations (lead_intake_token);
