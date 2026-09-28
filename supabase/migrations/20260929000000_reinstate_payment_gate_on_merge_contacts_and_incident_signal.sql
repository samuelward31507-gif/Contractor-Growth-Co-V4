-- Phase 0 (Foundation Trust), item 1: reinstate the payment-gate check on
-- merge_contacts and record_automation_incident_signal.
--
-- 20260921160000_payment_gate_rpc_enforcement.sql originally added
-- organization_payment_active() to both of these functions (among 11
-- others). Both were independently redefined by later, unrelated feature
-- migrations - each based on a copy of the function predating that fix -
-- and neither later migration carried the check forward:
--
--   merge_contacts: redefined by 20260925040000_merge_contacts_reassign_
--   opportunities.sql (added opportunities reassignment on merge). That
--   migration's own body keeps the existing is_org_admin(p_organization_id)
--   check but never calls organization_payment_active().
--
--   record_automation_incident_signal: redefined twice more -
--   20260924110000_human_escalation_incident_category.sql and
--   20260926000000_automation_degraded_alert.sql (each only widening the
--   category allowlist). The second of those two already self-documented
--   the gap in its own header comment ("the CURRENT LIVE
--   record_automation_incident_signal body ... does not include the
--   organization_payment_active check ... out of this task's scope") -
--   confirmed, not assumed, by reading pg_get_functiondef against the live
--   database before writing this migration, exactly as that comment's own
--   author did.
--
-- This migration reproduces each function's current live body exactly
-- (confirmed via pg_get_functiondef immediately before writing this file),
-- re-inserting exactly one guard per function, in the same position and
-- with the same wording 20260921160000 originally used, and changes
-- nothing else:
--
--   merge_contacts: `if not organization_payment_active(p_organization_id)
--   then raise exception 'Organization payment is not active'` immediately
--   after the existing is_org_admin check (no service_role branch exists
--   in this function - it always requires auth.uid()).
--
--   record_automation_incident_signal: the same check, inside the existing
--   `if not v_is_service_role` block, immediately after the existing
--   is_org_member check - service_role calls (the automation-health/
--   incident pipeline, running under lib/supabase/service.ts) remain
--   completely untouched, exactly as the original fix intended.
--
-- FAIL-CLOSED / RECURSION: unchanged from the original fix's own reasoning
-- - organization_payment_active() returns false for a null/nonexistent org
-- id, and introduces no new recursion risk beyond the is_org_admin()/
-- is_org_member() calls these functions already make.

create or replace function public.merge_contacts(p_organization_id uuid, p_source_contact_id uuid, p_target_contact_id uuid, p_reason text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
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

  if not public.organization_payment_active(p_organization_id) then
    raise exception 'Organization payment is not active';
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

create or replace function public.record_automation_incident_signal(p_organization_id uuid, p_category text, p_severity text, p_fingerprint text, p_title text, p_description text default null::text, p_automation_id text default null::text, p_workflow_execution_id uuid default null::uuid, p_metadata jsonb default '{}'::jsonb)
returns automation_incidents
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_is_service_role boolean;
  v_category text;
  v_severity text;
  v_fingerprint text;
  v_title text;
  v_description text;
  v_automation_id text;
  v_metadata jsonb;
  v_row public.automation_incidents;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if p_organization_id is null then
    raise exception 'organization_id is required';
  end if;

  if not v_is_service_role then
    if auth.uid() is null then
      raise exception 'Not authenticated';
    end if;
    if not public.is_org_member(p_organization_id) then
      raise exception 'Not authorized';
    end if;
    if not public.organization_payment_active(p_organization_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;

  v_category := nullif(trim(p_category), '');
  if v_category is null or v_category not in (
    'workflow_failed', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed',
    'human_escalation_requested',
    'scheduled_automation_stale'
  ) then
    raise exception 'Unsupported incident category';
  end if;

  v_severity := nullif(trim(p_severity), '');
  if v_severity is null or v_severity not in ('info', 'warning', 'critical') then
    raise exception 'Unsupported incident severity';
  end if;

  v_fingerprint := nullif(trim(p_fingerprint), '');
  if v_fingerprint is null or length(v_fingerprint) > 300 then
    raise exception 'Invalid fingerprint';
  end if;

  v_title := nullif(trim(p_title), '');
  if v_title is null or length(v_title) > 200 then
    raise exception 'Invalid title';
  end if;

  v_description := nullif(trim(p_description), '');
  if v_description is not null then
    v_description := left(v_description, 1000);
  end if;

  v_automation_id := nullif(trim(p_automation_id), '');

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.automation_incidents as ai (
    organization_id, automation_id, workflow_execution_id, category, severity, status,
    fingerprint, title, description, metadata
  ) values (
    p_organization_id, v_automation_id, p_workflow_execution_id, v_category, v_severity, 'open',
    v_fingerprint, v_title, v_description, v_metadata
  )
  on conflict (organization_id, fingerprint) where status in ('open', 'acknowledged')
  do update set
    occurrence_count = ai.occurrence_count + 1,
    last_seen_at = now(),
    workflow_execution_id = coalesce(excluded.workflow_execution_id, ai.workflow_execution_id),
    title = excluded.title,
    description = excluded.description,
    metadata = excluded.metadata,
    updated_at = now(),
    category = case
      when ai.category = 'workflow_failed' and ai.occurrence_count + 1 >= 3 then 'repeated_workflow_failure'
      else ai.category
    end,
    severity = case
      when ai.category = 'workflow_failed' and ai.occurrence_count + 1 >= 3 then 'critical'
      else ai.severity
    end
  returning * into v_row;

  return v_row;
end;
$$;
