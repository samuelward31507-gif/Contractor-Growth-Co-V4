-- Phase 4.7: Post-Job Review + Referral Automation.
--
-- Confirmed by audit: no reviews/referrals table, no review-url column,
-- anywhere in this codebase - not even a placeholder UI page exists for
-- either concept. Per explicit user decision, this phase needs no new
-- table at all: a single combined post-job message (thank-you + review
-- ask when a URL is configured + referral ask always) is tracked entirely
-- through the existing automation_events/workflow_executions/
-- ai_interactions infrastructure, keyed to the completed job
-- (entity_type 'job'). The only schema gap is that Trackpr has nowhere to
-- store a contractor's real review link - getBusinessProfile() already
-- reads name/phone/email/address/website/timezone directly from
-- organizations, so review_url belongs there too, following the exact
-- same convention rather than inventing a new settings table.
--
-- Nullable, no default: when unset, the post-job message's outbound gate
-- (lib/automation/outbound-gate.ts) omits the review-ask portion and
-- still sends the referral-ask portion - missing review_url is never a
-- reason to block the whole message, per explicit user decision. When
-- set, the stored value is passed to n8n/the AI as-is and the AI is
-- instructed to use it exactly, never invent or modify it - Trackpr is
-- the only place this value can ever originate.

alter table public.organizations
add column review_url text;
