-- Contact Deduplication V1.
--
-- Audited first (production, this migration's own session):
--   - Zero existing duplicate contacts by raw phone, by case-insensitive
--     email, or by digits-only phone, within any organization - confirmed
--     by three separate GROUP BY ... HAVING COUNT(*) > 1 queries against
--     production immediately before writing this migration. This migration
--     is therefore purely additive to the schema; it does not need to
--     resolve any pre-existing conflicting data.
--   - Exactly two production code paths ever insert a contact
--     (app/(app)/contacts/actions.ts's createContact, and
--     app/api/webhooks/sms/inbound/route.ts's auto-create-on-first-message)
--     - both are updated in this same feature to go through the new
--     resolver (lib/contacts/resolve.ts), which is what actually keeps
--     phone_normalized/email_normalized correct going forward. This
--     migration only adds the schema those paths and the merge RPC rely on.
--   - Exactly eight tables have a foreign key to contacts(id): ai_interactions,
--     appointments, conversations, estimates, jobs, leads, referral_requests,
--     review_requests - all ON DELETE SET NULL today. Confirmed by querying
--     information_schema directly, not assumed. The merge RPC below
--     reassigns contact_id on all eight, and no others.
--   - conversations has an existing partial unique index,
--     conversations_org_contact_channel_open_key (organization_id,
--     contact_id, channel) WHERE status = 'open' AND contact_id IS NOT NULL
--     - the one real uniqueness hazard a merge can hit (source and target
--     each having their own open conversation on the same channel). The
--     merge RPC closes the source's conflicting open conversation before
--     reassigning it, rather than violating that constraint or silently
--     leaving two open threads.

-- 1. Identity columns -----------------------------------------------------
--
-- Computed application-side (lib/contacts/identity.ts) at every write, not
-- as a generated column - normalization involves a real judgment call (the
-- North-American-default-for-10-digits rule) that belongs in one reviewable
-- TypeScript function, not duplicated as SQL. Nullable: a contact with no
-- phone, no email, or an unnormalizable/ambiguous value simply has a null
-- identity column for that field, and is correctly excluded from the
-- uniqueness guarantee below (an ambiguous phone must never be treated as
-- an exact identity match, per explicit product decision).
alter table public.contacts
  add column phone_normalized text,
  add column email_normalized text;

-- 2. Soft-merge / archive columns ------------------------------------------
--
-- A merged contact is never deleted (data-loss risk, and every historical
-- relationship already reassigned to the target would otherwise dangle) -
-- it is marked merged_into_id/merged_at and excluded from the active-identity
-- uniqueness constraint below, so its original phone/email can never block
-- a genuinely new contact from later using that same identity, while still
-- being fully queryable for history/audit.
alter table public.contacts
  add column merged_into_id uuid references public.contacts(id) on delete set null,
  add column merged_at timestamp with time zone;

alter table public.contacts
  add constraint contacts_merged_into_not_self
  check (merged_into_id is null or merged_into_id <> id);

-- 3. Race-proof identity uniqueness, organization-scoped -----------------
--
-- Partial unique indexes, not a plain unique constraint: NULL identity
-- values (no phone/no email/ambiguous) must never collide with each other,
-- and a merged (archived) contact's old identity must never block a new
-- one - both handled by the WHERE clause, not by application logic alone.
-- This is the actual database-level integrity boundary Step 12 requires:
-- two concurrent inserts for the same organization_id + phone_normalized
-- (or email_normalized) cannot both succeed - the loser gets a real 23505,
-- which lib/contacts/resolve.ts below treats as "someone else just created
-- this contact, go read it" rather than a hard failure.
create unique index contacts_org_phone_normalized_unique
  on public.contacts (organization_id, phone_normalized)
  where phone_normalized is not null and merged_into_id is null;

create unique index contacts_org_email_normalized_unique
  on public.contacts (organization_id, email_normalized)
  where email_normalized is not null and merged_into_id is null;

create index idx_contacts_merged_into on public.contacts (merged_into_id);

-- 4. Merge RPC --------------------------------------------------------------
--
-- The only sanctioned way to merge two contacts. SECURITY DEFINER so the
-- entire operation (survivor-field resolution, all eight FK reassignments,
-- the conversations open-channel conflict, the soft-merge marker, and the
-- audit_log row) runs as one real Postgres transaction - a set of separate
-- PostgREST calls from application code could not offer this atomicity, and
-- contacts' own RLS (is_org_member - any member can update/delete) is
-- deliberately NOT the authorization boundary for merging; this function's
-- own is_org_admin() check is, matching the product requirement that only
-- an owner/admin may merge.
--
-- p_organization_id is supplied by the caller (already resolved server-side
-- from the authenticated session, exactly like every other Trackpr
-- mutation) but is never trusted alone: both p_source_contact_id and
-- p_target_contact_id are independently re-verified to actually belong to
-- that exact organization_id before anything is touched, so a
-- client-controlled organization_id can never redirect the operation onto
-- another organization's contacts.
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

  -- Row-level re-verification: the real cross-org guard. A caller cannot
  -- merge a contact that does not actually belong to p_organization_id,
  -- regardless of what the RPC arguments claim.
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

  -- Survivor-field policy (Step 8): prefer the target's own value when
  -- present; fill a genuinely missing target field from the source; never
  -- overwrite a populated target field. phone/phone_normalized and
  -- email/email_normalized are always taken from the SAME row together
  -- (never mixed across source/target) so the normalized column stays
  -- consistent with its own raw value without recomputing normalization in
  -- SQL. notes are not concatenated in V1 - kept simple and deterministic.
  --
  -- Soft-merge the source FIRST, before touching the target's identity
  -- columns: contacts_org_phone_normalized_unique/contacts_org_email_
  -- normalized_unique both exclude rows where merged_into_id is not null,
  -- so the source must release its claim on that phone_normalized/
  -- email_normalized value before the target can be given that same value
  -- below (e.g. filling the target's missing phone from the source's) -
  -- otherwise this would self-deadlock against the very index it's
  -- supposed to satisfy. The source is never deleted, so nothing here
  -- loses data; only its identity uniqueness marker moves off it.
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
