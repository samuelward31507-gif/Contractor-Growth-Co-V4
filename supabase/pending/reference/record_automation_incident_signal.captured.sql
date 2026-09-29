-- CAPTURED VERBATIM from the isolated test project trackpr-stripe-test
-- (lwofqffxagxiqodqvcfr) on 2026-09-28 with a read-only query:
--
--   select pg_get_functiondef('public.record_automation_incident_signal(uuid,text,text,text,text,text,text,uuid,jsonb)'::regprocedure);
--
-- Length 3554 characters, md5 dfca7377dd707f2cd7814f87ae84a6bf of the exact
-- pg_get_functiondef output (everything below this comment block). The test
-- project was built by replaying every file in supabase/migrations/, so this
-- is the body 20260929000000_reinstate_payment_gate_on_merge_contacts_and_
-- incident_signal.sql produces. It was NOT read from production: production
-- is the source of truth for every object (merge_contacts once drifted from
-- the repository - see merge_contacts.production.sql), so the apply
-- procedure for online_payments.sql requires re-running the query above
-- against production and getting this same md5 before applying. If it
-- differs, stop: section 4 of online_payments.sql and its rollback must be
-- rebased on the production body.
--
-- online_payments.sql re-creates this function with exactly one change (the
-- 'online_payment_reconciliation' category added to the allowlist);
-- online_payments_rollback.sql restores this body.
CREATE OR REPLACE FUNCTION public.record_automation_incident_signal(p_organization_id uuid, p_category text, p_severity text, p_fingerprint text, p_title text, p_description text DEFAULT NULL::text, p_automation_id text DEFAULT NULL::text, p_workflow_execution_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS automation_incidents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
