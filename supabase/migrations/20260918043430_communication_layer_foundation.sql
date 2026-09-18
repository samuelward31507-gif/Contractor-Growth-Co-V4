-- Phase 3: Trackpr Communication Layer foundation.
--
-- Purely additive schema - no existing column, constraint, or RLS policy is
-- changed. conversations/messages already have full client-facing RLS
-- (is_org_member) from the initial schema, and the service-role callback/
-- webhook paths bypass RLS entirely (same pattern already used by the n8n
-- callback route for ai_interactions), so no new policy or RPC is needed
-- here - only the columns and indexes the audited architecture requires.

-- 1. messages: delivery-state tracking ---------------------------------------
--
-- messages was an append-only log with no status concept. A real message now
-- has a lifecycle (queued -> sent -> delivered/failed for outbound; received
-- is terminal for inbound; logged is the existing "manually typed, never
-- transmitted" CRM-note case). status_reason carries the provider's failure
-- detail. workflow_execution_id links an AI/automation-authored outbound
-- message back to the exact run that produced it (not automation_event_id -
-- a single event can have multiple execution attempts, and this ties a
-- message to the specific one that sent it).

alter table public.messages
  add column status text not null default 'queued',
  add column status_reason text,
  add column workflow_execution_id uuid references public.workflow_executions(id) on delete set null,
  add column updated_at timestamptz not null default now();

alter table public.messages
  add constraint messages_status_check
  check (status = any (array['queued', 'sent', 'delivered', 'failed', 'undelivered', 'received', 'logged']));

create trigger messages_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

-- Idempotency for inbound webhooks and provider status callbacks: a replayed
-- Twilio request with the same provider message SID must never create a
-- second row. NULL is excluded so outbound messages can be inserted
-- status='queued' before a provider id exists.
create unique index messages_provider_message_id_key
  on public.messages (provider_message_id)
  where provider_message_id is not null;

-- 2. conversations: one open thread per contact+channel ----------------------
--
-- Find-or-create logic (inbound webhook, outbound send) relies on there
-- being at most one open conversation per contact per channel. This was an
-- unenforced convention; making it a real constraint prevents a race (two
-- concurrent inbound messages) from ever creating two open threads.
create unique index conversations_org_contact_channel_open_key
  on public.conversations (organization_id, contact_id, channel)
  where status = 'open' and contact_id is not null;

-- 3. organizations: outbound SMS number ---------------------------------------
--
-- The org's own business phone (organizations.phone) is a display/contact
-- number, not necessarily the Twilio-provisioned number messages are sent
-- from - those are two different concerns that happen to often be unset
-- today. sms_phone_number is nullable: a real value is assigned once an org
-- actually provisions SMS, not by this migration.
alter table public.organizations
  add column sms_phone_number text;

-- 4. contacts: SMS opt-out -----------------------------------------------------
--
-- Opt-out is per phone number (per contact), not per conversation - a
-- contact who has texted STOP must stay opted out even if a new conversation
-- thread opens later. Checked by the outbound send path before every send,
-- not only at webhook-receipt time.
alter table public.contacts
  add column sms_opt_out boolean not null default false;
