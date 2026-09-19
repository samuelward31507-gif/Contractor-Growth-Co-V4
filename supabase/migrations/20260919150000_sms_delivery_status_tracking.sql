-- Twilio SMS Delivery Status Tracking V1.
--
-- Audited first: messages.status already has a CHECK constraint allowing
-- 'queued'/'sent'/'delivered'/'failed'/'undelivered' (see
-- 20260918043430_communication_layer_foundation.sql) - no enum/constraint
-- change is needed here. messages.provider_message_id already has the
-- partial unique index (messages_provider_message_id_key) this feature's
-- webhook relies on for both message resolution and idempotency. messages
-- has no client-facing UPDATE policy at all today (only messages_insert/
-- messages_select), so the new status webhook uses the service-role client
-- exactly like app/api/webhooks/sms/inbound/route.ts already does - no new
-- RLS policy is added, and none is needed: service-role bypasses RLS, and
-- the webhook's own authorization boundary is "the message must already
-- exist, resolved only by provider_message_id, and its organization_id is
-- read from that row, never accepted from the request."
--
-- The one genuine schema gap: there is nowhere to record Twilio's numeric
-- ErrorCode separately from the free-text status_reason. Adding it as its
-- own bounded column keeps status_reason for the sanitized human-readable
-- message and this column for the short, queryable code.
alter table public.messages
  add column provider_error_code text;

alter table public.messages
  add constraint messages_provider_error_code_length
  check (provider_error_code is null or char_length(provider_error_code) <= 32);
