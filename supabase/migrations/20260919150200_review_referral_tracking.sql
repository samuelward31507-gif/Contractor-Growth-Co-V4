-- Review & Referral Tracking V1.
--
-- Audited first: lib/automation/post-job-followup.ts already emits one
-- combined `job.post_followup` event/workflow execution per completed job
-- (idempotent via `post_job_followup:<job_id>`), and the n8n callback route
-- already sends the resulting message through the existing
-- sendOutboundMessage()/evaluateOutboundGate() path exactly like every
-- other automation. None of that changes. What does not exist today: any
-- row recording that a review or referral was ever actually asked for, or
-- what happened after - "sent an SMS" and "got a completed review" were
-- indistinguishable. This migration adds exactly the two tables needed to
-- close that gap, modeled directly on jobs' own shape/conventions (same
-- is_org_member RLS pattern, same set_updated_at trigger, same nullable
-- ON DELETE SET NULL relationship style for contact_id/lead_id).
--
-- One row per job, ever, for each request type - enforced by a real unique
-- index (jobs_estimate_id_unique's own precedent), not only application
-- logic - because a completed job can only ever produce one post_job_
-- followup send attempt (idempotent event), so it can only ever have one
-- review ask and one referral ask outcome, however many times that single
-- attempt is retried.
--
-- Status model, deliberately asymmetric between who can set which values:
-- the automation itself can only ever move a row to 'requested' (the send
-- succeeded) or 'failed' (it didn't, for any reason - gate block or
-- provider failure) - "a sent SMS means requested, not completed" per
-- explicit product decision. 'responded' is set deterministically by the
-- inbound webhook the moment the contact sends any non-keyword reply while
-- a request is still 'requested' - not by AI, not by keyword-guessing
-- positive/negative sentiment. 'completed'/'declined' (review) and
-- 'converted'/'declined' (referral) are never inferred by this system at
-- all - Trackpr has no way to confirm a real Google review was left or a
-- real referral turned into a customer without a real integration; those
-- are recorded only via an explicit, authenticated contractor action
-- (app/(app)/jobs/actions.ts), the same "human confirms, AI/automation
-- never invents" boundary already established for STOP/START/HELP and the
-- outbound gate elsewhere in this codebase. 'not_requested' exists in the
-- enum for schema completeness/future manual flows (e.g. a future "request
-- a review" action independent of job completion) but is never produced by
-- this automation path - a row simply does not exist until a request is
-- actually attempted.

create table public.review_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  workflow_execution_id uuid references public.workflow_executions(id) on delete set null,
  status text not null default 'not_requested'
    check (status in ('not_requested', 'requested', 'responded', 'completed', 'declined', 'failed')),
  -- Snapshot of organizations.review_url at the moment the request was
  -- actually sent, not a live join - the org's configured URL can change
  -- later, and this preserves what the customer was actually sent.
  review_url text,
  requested_at timestamp with time zone,
  responded_at timestamp with time zone,
  resolved_at timestamp with time zone,
  failure_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.referral_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  workflow_execution_id uuid references public.workflow_executions(id) on delete set null,
  status text not null default 'not_requested'
    check (status in ('not_requested', 'requested', 'responded', 'converted', 'declined', 'failed')),
  -- V1 attribution structure (requirement: "clean V1 structure that can
  -- later support customer -> referral -> referred lead -> converted job"
  -- without overbuilding a full attribution system now). Set only via an
  -- explicit contractor action linking a specific existing lead they know
  -- came from this referral - never inferred. ON DELETE SET NULL: deleting
  -- the referred lead later must never delete the referral record itself.
  referred_lead_id uuid references public.leads(id) on delete set null,
  requested_at timestamp with time zone,
  responded_at timestamp with time zone,
  resolved_at timestamp with time zone,
  failure_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index idx_review_requests_org on public.review_requests (organization_id);
create index idx_review_requests_contact on public.review_requests (contact_id);
create index idx_review_requests_status on public.review_requests (organization_id, status);
create unique index review_requests_job_id_unique on public.review_requests (job_id);

create index idx_referral_requests_org on public.referral_requests (organization_id);
create index idx_referral_requests_contact on public.referral_requests (contact_id);
create index idx_referral_requests_status on public.referral_requests (organization_id, status);
create index idx_referral_requests_referred_lead on public.referral_requests (referred_lead_id);
create unique index referral_requests_job_id_unique on public.referral_requests (job_id);

create trigger review_requests_updated_at
  before update on public.review_requests
  for each row execute function public.set_updated_at();

create trigger referral_requests_updated_at
  before update on public.referral_requests
  for each row execute function public.set_updated_at();

alter table public.review_requests enable row level security;
alter table public.referral_requests enable row level security;

-- Matches jobs' own RLS exactly (is_org_member, not is_org_admin, for both
-- read and write) - any org member can see and update review/referral
-- outcomes for their own organization's jobs, the same access level they
-- already have over the jobs themselves. The automation's own writes
-- (creating a request row, recording a response) go through the
-- service-role client from the n8n callback / inbound webhook routes,
-- exactly like every other automation-authored row in this schema (RLS is
-- bypassed there, not weakened for it).
create policy review_requests_select on public.review_requests
  for select using (is_org_member(organization_id));
create policy review_requests_insert on public.review_requests
  for insert with check (is_org_member(organization_id));
create policy review_requests_update on public.review_requests
  for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy referral_requests_select on public.referral_requests
  for select using (is_org_member(organization_id));
create policy referral_requests_insert on public.referral_requests
  for insert with check (is_org_member(organization_id));
create policy referral_requests_update on public.referral_requests
  for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

grant select, insert, update, references, trigger on public.review_requests to anon, authenticated, service_role;
grant select, insert, update, references, trigger on public.referral_requests to anon, authenticated, service_role;
