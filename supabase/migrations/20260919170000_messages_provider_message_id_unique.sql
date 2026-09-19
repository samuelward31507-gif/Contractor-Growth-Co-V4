-- Production-readiness audit finding (HIGH, matches the known "messages
-- INSERT integrity" backlog item): messages.provider_message_id had no
-- unique constraint at the database level. The inbound SMS webhook
-- (app/api/webhooks/sms/inbound/route.ts) only had a plain SELECT-then-
-- INSERT idempotency check with no transactional guarantee - a classic
-- TOCTOU race. Twilio retries webhook deliveries under response latency (a
-- normal, expected occurrence, not an edge case), so two concurrent
-- requests for the same physical inbound SMS could both pass the "no
-- existing row" check and each insert their own `messages` row, showing
-- the same customer text twice in the conversation UI.
--
-- This does not, by itself, cause a duplicate automation dispatch or a
-- duplicate outbound send - customer.message.received's own idempotency key
-- (`customer.message.received:<providerMessageId>`, backed by the real
-- automation_events_org_idempotency_key unique index) already prevents
-- that. This migration closes the narrower, still-real gap: duplicate
-- `messages` rows for one physical text.
--
-- Partial (WHERE provider_message_id IS NOT NULL) because outbound messages
-- pass through a queued state before a provider id is assigned
-- (lib/messaging/outbound.ts's sendOutboundMessage: insert with status
-- 'queued' and provider_message_id null, then update after the provider
-- call returns) - multiple NULLs must remain allowed, only a real,
-- non-null provider id must be unique.
create unique index messages_provider_message_id_unique
  on public.messages (provider_message_id)
  where provider_message_id is not null;
