-- Pass 4 (Customer Lifetime + Repeat Business Engine), P0 hardening: fixes
-- a real data-integrity gap found during the Pass 4 read-only audit.
--
-- merge_contacts (20260919153000_contact_deduplication.sql) reassigns
-- contact_id across all eight tables that had a foreign key to contacts(id)
-- at the time it was written: ai_interactions, appointments, conversations,
-- estimates, jobs, leads, referral_requests, review_requests. The
-- opportunities table (20260925020000_opportunities.sql) postdates that
-- migration, so it was never added to the reassignment list - after a
-- merge, an open opportunity sourced from the merged-away contact kept
-- pointing at a contact whose merged_into_id is now set, instead of the
-- surviving contact.
--
-- This migration only adds the missing opportunities.contact_id
-- reassignment to the same function, via create or replace function (same
-- signature, same SECURITY DEFINER/search_path/grants - safe to rerun).
-- Every other line of merge_contacts is copied verbatim, unchanged.
--
-- Why this is safe with no uniqueness hazard (the one thing this kind of
-- change must rule out): opportunities' only uniqueness constraint is the
-- partial unique index opportunities_org_type_source_open_unique on
-- (organization_id, type, source_entity_id) WHERE status = 'open' -
-- contact_id is not part of it at all. A blind
-- `update opportunities set contact_id = target where contact_id = source`
-- can never violate that index, regardless of what rows the source and
-- target already have - the exact same "no uniqueness hazard" reasoning
-- the original migration already documented for leads/referral_requests/
-- review_requests (whose own uniqueness constraints are keyed on job_id or
-- nothing at all, never contact_id). This is therefore a plain reassignment
-- with no conditional/conflict-avoidance logic needed, unlike
-- conversations' real open-channel hazard elsewhere in this same function.
--
-- Deliberately NOT touched: opportunities.source_entity_id. For the one
-- opportunity type whose source_entity_id happens to equal a contact id
-- (dormant_customer, source_entity_type = 'contact'), leaving
-- source_entity_id pointing at the old (source) contact is not a
-- correctness bug in practice - lib/opportunities/detect.ts's
-- syncOpportunities recomputes every dormant-customer candidate from
-- current jobs data on its next run (called on every dashboard load); once
-- the source contact's jobs have already been reassigned to the target by
-- this same merge, the source contact can never again be detected as a
-- fresh dormant candidate, so that stale row is auto-resolved by
-- syncOpportunities' own existing "no longer a detected candidate" logic,
-- and a fresh, correctly-keyed opportunity is created for the target if it
-- is itself dormant. Rewriting source_entity_id here would mean redefining
-- what the opportunity is actually about, which is out of scope for a
-- contact-merge fix and not what this pass was asked to change.

create or replace function public.merge_contacts(
  p_organization_id uuid,
  p_source_contact_id uuid,
  p_target_contact_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_source record;
  v_target record;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
  v_source_open_conv record;
  v_target_has_open boolean;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_organization_id is null then
    raise exception 'organization_id is required';
  end if;

  if not public.is_org_admin(p_organization_id) then
    raise exception 'Not authorized';
  end if;

  if p_source_contact_id is null or p_target_contact_id is null then
    raise exception 'source and target contact ids are required';
  end if;

  if p_source_contact_id = p_target_contact_id then
    raise exception 'Cannot merge a contact into itself';
  end if;

  select * into v_source from public.contacts
    where id = p_source_contact_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'Source contact not found in this organization';
  end if;

  select * into v_target from public.contacts
    where id = p_target_contact_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'Target contact not found in this organization';
  end if;

  if v_source.merged_into_id is not null then
    raise exception 'Source contact has already been merged';
  end if;
  if v_target.merged_into_id is not null then
    raise exception 'Target contact has already been merged - merge into its current survivor instead';
  end if;

  update public.contacts set
    merged_into_id = p_target_contact_id,
    merged_at = now()
  where id = p_source_contact_id;

  update public.contacts set
    first_name = coalesce(nullif(trim(v_target.first_name), ''), v_source.first_name),
    last_name = coalesce(nullif(trim(v_target.last_name), ''), v_source.last_name),
    company_name = coalesce(nullif(trim(v_target.company_name), ''), v_source.company_name),
    notes = coalesce(nullif(trim(v_target.notes), ''), v_source.notes),
    phone = case when v_target.phone is not null and trim(v_target.phone) <> '' then v_target.phone else v_source.phone end,
    phone_normalized = case when v_target.phone is not null and trim(v_target.phone) <> '' then v_target.phone_normalized else v_source.phone_normalized end,
    email = case when v_target.email is not null and trim(v_target.email) <> '' then v_target.email else v_source.email end,
    email_normalized = case when v_target.email is not null and trim(v_target.email) <> '' then v_target.email_normalized else v_source.email_normalized end
  where id = p_target_contact_id;

  -- ai_interactions
  update public.ai_interactions set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('ai_interactions', v_n);

  -- appointments
  update public.appointments set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('appointments', v_n);

  -- estimates
  update public.estimates set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('estimates', v_n);

  -- jobs
  update public.jobs set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('jobs', v_n);

  -- leads (no uniqueness hazard - a contact may have multiple leads)
  update public.leads set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_n);

  -- referral_requests (unique on job_id, not contact_id - no hazard)
  update public.referral_requests set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('referral_requests', v_n);

  -- review_requests (same - unique on job_id)
  update public.review_requests set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('review_requests', v_n);

  -- opportunities (Pass 4 P0 fix - see this migration's own header. No
  -- uniqueness hazard: contact_id is not part of
  -- opportunities_org_type_source_open_unique.)
  update public.opportunities set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('opportunities', v_n);

  -- conversations: the one real uniqueness hazard. For every OPEN
  -- conversation the source has, on a channel where the target ALSO
  -- already has an open conversation, close the source's conversation
  -- first (history preserved, just no longer "the" open thread) so
  -- reassigning it can never violate conversations_org_contact_channel_
  -- open_key. Every other conversation (closed, or open on a channel the
  -- target has no open thread on) is reassigned as-is.
  for v_source_open_conv in
    select id, channel from public.conversations
    where contact_id = p_source_contact_id and status = 'open'
  loop
    select exists (
      select 1 from public.conversations
      where contact_id = p_target_contact_id
        and channel = v_source_open_conv.channel
        and status = 'open'
    ) into v_target_has_open;

    if v_target_has_open then
      update public.conversations set status = 'closed' where id = v_source_open_conv.id;
    end if;
  end loop;

  update public.conversations set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_n);

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, 'contact_merged', 'contact', p_target_contact_id, null,
    jsonb_build_object(
      'source_contact_id', p_source_contact_id,
      'target_contact_id', p_target_contact_id,
      'reason', p_reason,
      'reassigned_counts', v_counts
    )
  );

  return jsonb_build_object(
    'ok', true,
    'source_contact_id', p_source_contact_id,
    'target_contact_id', p_target_contact_id,
    'reassigned_counts', v_counts
  );
end;
$$;

revoke all on function public.merge_contacts(uuid, uuid, uuid, text) from public;
revoke all on function public.merge_contacts(uuid, uuid, uuid, text) from anon;
grant execute on function public.merge_contacts(uuid, uuid, uuid, text) to authenticated;
