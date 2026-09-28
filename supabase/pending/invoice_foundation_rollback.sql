-- Trackpr Phase 1B - Invoice Foundation ROLLBACK / RECOVERY.
--
-- Reverses supabase/pending/invoice_foundation.sql completely: drops the two
-- new tables (and therefore any invoices and customer_payments rows), the
-- trigger functions, the audit RPC, and restores merge_contacts to the exact
-- body captured from production (supabase/pending/reference/
-- merge_contacts.production.sql, md5 16eb8b6540778969e6d489953494c44b).
--
-- Intended for the window before any real invoice exists. Once invoices
-- exist, prefer hiding the UI over running this - it destroys money history.
-- The guard is the first statement: it refuses to run if any customer
-- payment has been recorded, unless you deliberately delete that check.
--
-- This script does not touch supabase_migrations.schema_migrations. If the
-- forward migration was recorded there, remove or keep that ledger entry as
-- a separate, explicit decision.

begin;

do $$
begin
  if to_regclass('public.customer_payments') is not null
     and exists (select 1 from public.customer_payments) then
    raise exception 'Refusing to roll back: customer_payments contains recorded money. Remove this guard only if you intend to destroy that history.';
  end if;
end $$;

-- Order matters: payments reference invoices; triggers before tables is not
-- required (dropping a table drops its triggers) but functions must outlive
-- nothing, so tables go first, then functions.
drop table if exists public.customer_payments;
drop table if exists public.invoices;

drop function if exists public.customer_payments_immutable();
drop function if exists public.customer_payments_apply();
drop function if exists public.customer_payments_guard_insert();
drop function if exists public.invoices_guard_delete();
drop function if exists public.invoices_guard_update();
drop function if exists public.invoices_guard_insert();
drop function if exists public.create_invoice_audit_event(uuid, text, text, uuid, jsonb);

-- Restore merge_contacts to the captured production body (byte-identical to
-- supabase/pending/reference/merge_contacts.production.sql).
CREATE OR REPLACE FUNCTION public.merge_contacts(p_organization_id uuid, p_source_contact_id uuid, p_target_contact_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

commit;
