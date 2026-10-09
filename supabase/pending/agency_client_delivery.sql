-- Agency client delivery (Phase 3): a confirmed Agency client moves through
-- onboarding_not_started -> onboarding -> ready_to_launch -> live ->
-- ongoing_management, with scoped onboarding tasks, an audited history, a
-- launch gate enforced here, and a recorded launch decision.
--
-- STATUS: PENDING. Requires agency_client_handoff.sql (agency_clients) and
-- the agency foundation (agency_admins, agency_organizations,
-- is_agency_admin()). Validate with
-- supabase/pending/scratch/validate-agency-client-delivery.mjs; TEST only.
--
-- Rules:
--  * Agency admins only. Every function re-checks is_agency_admin(); tables
--    are SELECT-only for admins (RLS) and written only by these functions.
--  * The confirmed terms and scope on agency_clients are immutable (guard
--    trigger). No amendment workflow here.
--  * Tasks come from a core list plus only the service modules an admin
--    selects when starting onboarding. Modules can be added later (recorded,
--    tasks added once - UNIQUE (client_id, template_key)); never removed.
--    Tasks are never deleted; an optional task can be closed as "won't do"
--    with a reason, a required one can't.
--  * Ready to launch needs every required task done and no task blocked.
--    Approving launch re-checks that inside the same transaction under a
--    row lock, refuses any failed critical readiness check, needs a written
--    acknowledgement when any check is unverified, and records the evidence.
--    One launch per client (UNIQUE) - a repeat returns the recorded launch.
--  * Every change goes into agency_client_events (append-only).
--  * Linking a Trackpr account is explicit and only to an organization that
--    is already in agency_organizations. Nothing here adds to
--    agency_organizations, changes Trackpr's Go Live, pauses or unpauses
--    automation, or sends anything.
--  * Writes carry the row version (updated_at) and are refused if stale;
--    creates carry a request id so retries are no-ops.
--
-- Idempotent. Rollback (non-destructive): agency_client_delivery_rollback.sql.

begin;

select set_config('agency.delivery_write', 'on', true);

-- 1. Agency client lifecycle columns ---------------------------------------------------

alter table public.agency_clients drop constraint if exists agency_clients_status_check;
alter table public.agency_clients add constraint agency_clients_status_check
  check (status in ('onboarding_not_started', 'onboarding', 'ready_to_launch', 'live', 'ongoing_management'));

alter table public.agency_clients
  add column if not exists status_changed_at timestamp with time zone not null default now(),
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists target_launch_date date,
  add column if not exists services text[] not null default '{}',
  add column if not exists onboarding_started_at timestamp with time zone,
  add column if not exists onboarding_started_by uuid references auth.users(id) on delete set null,
  add column if not exists launched_at timestamp with time zone,
  add column if not exists launched_by uuid references auth.users(id),
  add column if not exists organization_linked_at timestamp with time zone,
  add column if not exists organization_linked_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.agency_clients'::regclass and conname = 'agency_clients_services_check') then
    alter table public.agency_clients add constraint agency_clients_services_check
      check (services <@ array['lead_response', 'sms', 'follow_up', 'booking', 'crm', 'reporting', 'online_payments']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.agency_clients'::regclass and conname = 'agency_clients_organization_fk') then
    alter table public.agency_clients add constraint agency_clients_organization_fk foreign key (organization_id) references public.organizations(id) on delete set null;
  end if;
end $$;

create or replace trigger agency_clients_updated_at before update on public.agency_clients for each row execute function set_updated_at();

-- Terms and scope never change; lifecycle columns change only through the
-- functions below. Inserts (Phase 2 confirm) must start at the beginning.
create or replace function public.agency_clients_delivery_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Foreign-key actions (an account or organization removed: ON DELETE SET NULL) run one trigger level down.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'onboarding_not_started' or new.organization_id is not null or new.owner_user_id is not null or cardinality(new.services) > 0 or new.launched_at is not null then
      raise exception 'a new Agency client starts at onboarding not started' using errcode = 'FS422';
    end if;
    return new;
  end if;
  if new.name is distinct from old.name
     or new.contact_name is distinct from old.contact_name
     or new.contact_email is distinct from old.contact_email
     or new.contact_phone is distinct from old.contact_phone
     or new.setup_fee is distinct from old.setup_fee
     or new.monthly_fee is distinct from old.monthly_fee
     or new.currency is distinct from old.currency
     or new.scope is distinct from old.scope
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or (new.source_deal_id is distinct from old.source_deal_id and new.source_deal_id is not null)
     or (new.source_handoff_id is distinct from old.source_handoff_id and new.source_handoff_id is not null) then
    raise exception 'the confirmed terms and scope can''t be changed' using errcode = 'FS422';
  end if;
  if coalesce(current_setting('agency.delivery_write', true), '') <> 'on'
     and (new.status is distinct from old.status
       or new.status_changed_at is distinct from old.status_changed_at
       or new.owner_user_id is distinct from old.owner_user_id
       or new.target_launch_date is distinct from old.target_launch_date
       or new.services is distinct from old.services
       or new.onboarding_started_at is distinct from old.onboarding_started_at
       or new.onboarding_started_by is distinct from old.onboarding_started_by
       or new.launched_at is distinct from old.launched_at
       or new.launched_by is distinct from old.launched_by
       or (new.organization_id is distinct from old.organization_id and new.organization_id is not null)
       or new.organization_linked_at is distinct from old.organization_linked_at
       or new.organization_linked_by is distinct from old.organization_linked_by) then
    raise exception 'delivery changes go through the agency delivery functions' using errcode = 'FS422';
  end if;
  return new;
end;
$$;
create or replace trigger agency_clients_delivery_guard
  before insert or update on public.agency_clients
  for each row execute function public.agency_clients_delivery_guard();

-- 2. Tasks, events, launches --------------------------------------------------------------

create table if not exists public.agency_client_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.agency_clients(id),
  template_key text check (template_key is null or char_length(template_key) <= 80),
  module text check (module is null or module in ('core', 'lead_response', 'sms', 'follow_up', 'booking', 'crm', 'reporting', 'online_payments')),
  category text not null check (category in ('access', 'client_info', 'lead_intake', 'messaging', 'follow_up', 'crm', 'integrations', 'reporting', 'testing', 'training', 'other')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  required boolean not null,
  waiting_on text not null default 'agency' check (waiting_on in ('agency', 'client')),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done', 'wont_do')),
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 500),
  wont_do_reason text check (wont_do_reason is null or char_length(wont_do_reason) <= 500),
  owner_user_id uuid references auth.users(id) on delete set null,
  due_date date,
  sort_order integer not null default 1000,
  completed_at timestamp with time zone,
  -- Completion evidence is kept: an account that completed tasks can't be removed out from under it.
  completed_by uuid references auth.users(id),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint agency_client_tasks_template_unique unique (client_id, template_key),
  constraint agency_client_tasks_blocked_reason check ((status = 'blocked') = (blocked_reason is not null)),
  constraint agency_client_tasks_wont_do check ((status = 'wont_do') = (wont_do_reason is not null)),
  constraint agency_client_tasks_required_not_skipped check (not (required and status = 'wont_do')),
  constraint agency_client_tasks_done_evidence check ((status = 'done') = (completed_at is not null and completed_by is not null))
);
create index if not exists idx_agency_client_tasks_client on public.agency_client_tasks (client_id, sort_order);
create index if not exists idx_agency_client_tasks_open_due on public.agency_client_tasks (due_date) where status not in ('done', 'wont_do');

create table if not exists public.agency_client_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.agency_clients(id),
  task_id uuid references public.agency_client_tasks(id),
  kind text not null check (kind in (
    'onboarding_started', 'services_added', 'task_added', 'task_status_changed', 'task_details_changed',
    'details_changed', 'ready_to_launch', 'readiness_lost', 'launched', 'moved_to_ongoing', 'organization_linked'
  )),
  actor_user_id uuid references auth.users(id) on delete set null,
  occurred_at timestamp with time zone not null default now(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 20000)
);
create index if not exists idx_agency_client_events_client on public.agency_client_events (client_id, occurred_at desc);

create table if not exists public.agency_client_launches (
  id uuid primary key,
  client_id uuid not null unique references public.agency_clients(id),
  approved_by uuid not null references auth.users(id),
  approved_at timestamp with time zone not null default now(),
  resulting_status text not null check (resulting_status = 'live'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 50000)
);

comment on table public.agency_client_tasks is 'Onboarding / delivery tasks for an Agency client. Written only by the agency delivery functions; never deleted.';
comment on table public.agency_client_events is 'Append-only history of Agency client delivery changes.';
comment on table public.agency_client_launches is 'One recorded launch decision per Agency client, with the readiness evidence at that moment.';

-- Tasks change only through the functions; events and launches never change.
create or replace function public.agency_delivery_rows_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'agency delivery history can''t be deleted' using errcode = 'FS403';
  end if;
  -- An owner's or actor's account removed (ON DELETE SET NULL) runs one trigger level down.
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_table_name = 'agency_client_tasks' and coalesce(current_setting('agency.delivery_write', true), '') = 'on' then
    return new;
  end if;
  raise exception 'agency delivery records change only through the agency delivery functions' using errcode = 'FS403';
end;
$$;
create or replace trigger agency_client_tasks_guard before update or delete on public.agency_client_tasks for each row execute function public.agency_delivery_rows_guard();
create or replace trigger agency_client_events_guard before update or delete on public.agency_client_events for each row execute function public.agency_delivery_rows_guard();
create or replace trigger agency_client_launches_guard before update or delete on public.agency_client_launches for each row execute function public.agency_delivery_rows_guard();

alter table public.agency_client_tasks enable row level security;
alter table public.agency_client_events enable row level security;
alter table public.agency_client_launches enable row level security;
do $$
declare
  t text;
begin
  foreach t in array array['agency_client_tasks', 'agency_client_events', 'agency_client_launches'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_agency_admin_select') then
      execute format('create policy %I on public.%I for select to authenticated using (public.is_agency_admin())', t || '_agency_admin_select', t);
    end if;
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- 3. Templates -------------------------------------------------------------------------

-- The core list plus the given modules: (template_key, module, category, title, description, required, waiting_on, sort_order).
create or replace function public.agency_delivery_template(p_services text[])
returns table (template_key text, module text, category text, title text, description text, required boolean, waiting_on text, sort_order integer)
language sql
immutable
set search_path = ''
as $$
  select t.* from (values
    ('core.kickoff', 'core', 'access', 'Hold the kickoff call', 'Walk through the agreed scope, timeline and what we need from the client.', true, 'agency', 10),
    ('core.business_details', 'core', 'client_info', 'Collect business details and service area', 'Business name, hours, services, service area and any rules for handling leads.', true, 'client', 20),
    ('core.account_access', 'core', 'access', 'Get account access', 'Access to the tools in scope (website, ad accounts, calendars) - shared securely, never pasted here.', true, 'client', 30),
    ('core.trackpr_account', 'core', 'access', 'Set up and link the Trackpr account', 'Create the client''s Trackpr workspace and link it here so live health can be checked.', true, 'agency', 40),
    ('lead_response.intake_connected', 'lead_response', 'lead_intake', 'Connect lead sources to Trackpr', 'Website form, ads and other sources send leads to the client''s intake link.', true, 'agency', 100),
    ('lead_response.response_rules', 'lead_response', 'lead_intake', 'Confirm lead response rules', 'Who is alerted, response wording and after-hours handling.', true, 'client', 110),
    ('sms.number', 'sms', 'messaging', 'Provision the texting number', 'Buy and assign the client''s local texting number.', true, 'agency', 200),
    ('sms.a2p', 'sms', 'messaging', 'Complete A2P 10DLC registration', 'Carrier registration for business texting; needs the client''s business details.', true, 'client', 210),
    ('sms.test_message', 'sms', 'messaging', 'Send and receive a test text', 'Confirm a text goes out and a reply comes back on the client''s number.', true, 'agency', 220),
    ('follow_up.sequences', 'follow_up', 'follow_up', 'Configure follow-up sequences', 'Set up the follow-up steps and timing that were agreed.', true, 'agency', 300),
    ('follow_up.copy_approved', 'follow_up', 'follow_up', 'Get follow-up wording approved', 'The client approves the wording of every follow-up message.', true, 'client', 310),
    ('booking.calendar', 'booking', 'integrations', 'Connect the booking calendar', 'Connect the client''s calendar and confirm it shows as connected.', true, 'agency', 400),
    ('booking.rules', 'booking', 'integrations', 'Confirm booking rules', 'Appointment types, lengths and availability.', true, 'client', 410),
    ('crm.pipeline', 'crm', 'crm', 'Configure pipeline stages', 'Set up the pipeline stages the client works with.', true, 'agency', 500),
    ('crm.import', 'crm', 'crm', 'Import existing leads and customers', 'Bring in the client''s existing records, if they want them.', false, 'client', 510),
    ('reporting.setup', 'reporting', 'reporting', 'Set up monthly reporting', 'Agree what is reported each month and when.', true, 'agency', 600),
    ('reporting.baseline', 'reporting', 'reporting', 'Record baseline numbers', 'Current lead volume and response time, so results can be compared later.', false, 'client', 610),
    ('online_payments.connect', 'online_payments', 'integrations', 'Client completes Stripe Connect onboarding', 'The client finishes Stripe''s own onboarding in their Trackpr settings.', true, 'client', 700),
    ('online_payments.test', 'online_payments', 'integrations', 'Test an online invoice payment', 'Send a small test invoice and confirm it can be paid online.', false, 'agency', 710),
    ('core.end_to_end_test', 'core', 'testing', 'Run an end-to-end test', 'Send a test lead through every configured step and confirm each one worked.', true, 'agency', 900),
    ('core.client_acceptance', 'core', 'testing', 'Record client acceptance', 'The client has reviewed the setup and agreed it is ready.', true, 'client', 910),
    ('core.training', 'core', 'training', 'Train the client team', 'Show the team how to use the system day to day.', true, 'agency', 920)
  ) as t(template_key, module, category, title, description, required, waiting_on, sort_order)
  where t.module = 'core' or t.module = any(coalesce(p_services, '{}'::text[]));
$$;

-- 4. Helpers (not callable by clients) --------------------------------------------------------

-- The caller must be an agency admin; locks and returns the client (version-checked when given).
create or replace function public.agency_delivery_lock_client(p_client_id uuid, p_expected_updated_at timestamp with time zone)
returns public.agency_clients
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients;
begin
  if auth.uid() is null or not public.is_agency_admin() then
    raise exception 'not available' using errcode = 'FS404';
  end if;
  select * into v_client from public.agency_clients c where c.id = p_client_id for update;
  if not found then
    raise exception 'client not found' using errcode = 'FS404';
  end if;
  if p_expected_updated_at is not null and v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  return v_client;
end;
$$;

create or replace function public.agency_delivery_event(p_client_id uuid, p_task_id uuid, p_kind text, p_details jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.agency_client_events (client_id, task_id, kind, actor_user_id, details) values (p_client_id, p_task_id, p_kind, auth.uid(), coalesce(p_details, '{}'::jsonb));
$$;

-- What the launch gate sees right now.
create or replace function public.agency_delivery_gate(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tasks', count(*),
    'required', count(*) filter (where required),
    'required_done', count(*) filter (where required and status = 'done'),
    'blocked', count(*) filter (where status = 'blocked'),
    'passes', count(*) > 0 and count(*) filter (where required and status <> 'done') = 0 and count(*) filter (where status = 'blocked') = 0
  ) from public.agency_client_tasks where client_id = p_client_id;
$$;

-- A ready client whose gate no longer passes goes back to onboarding (recorded).
create or replace function public.agency_delivery_recheck_ready(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gate jsonb := public.agency_delivery_gate(p_client_id);
begin
  if (select status from public.agency_clients where id = p_client_id) = 'ready_to_launch' and not (v_gate->>'passes')::boolean then
    update public.agency_clients set status = 'onboarding', status_changed_at = now() where id = p_client_id;
    perform public.agency_delivery_event(p_client_id, null, 'readiness_lost', jsonb_build_object('gate', v_gate));
  end if;
end;
$$;

create or replace function public.agency_delivery_require_admin_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is not null and not exists (select 1 from public.agency_admins a where a.user_id = p_user_id) then
    raise exception 'tasks and clients can only be assigned to agency admins' using errcode = 'FS422';
  end if;
end;
$$;

create or replace function public.agency_delivery_clean_services(p_services text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text[] := coalesce((select array_agg(distinct s order by s) from unnest(coalesce(p_services, '{}'::text[])) s), '{}'::text[]);
begin
  if not v <@ array['lead_response', 'sms', 'follow_up', 'booking', 'crm', 'reporting', 'online_payments']::text[] then
    raise exception 'choose valid service modules' using errcode = 'FS422';
  end if;
  return v;
end;
$$;

-- 5. Lifecycle functions --------------------------------------------------------------------

create or replace function public.agency_start_onboarding(p_client_id uuid, p_expected_updated_at timestamp with time zone, p_services text[], p_owner_user_id uuid, p_target_launch_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
  v_services text[];
  v_count integer;
begin
  if v_client.status <> 'onboarding_not_started' then
    return jsonb_build_object('status', 'duplicate', 'client_status', v_client.status);
  end if;
  if p_expected_updated_at is null or v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  v_services := public.agency_delivery_clean_services(p_services);
  if cardinality(v_services) = 0 then
    raise exception 'choose at least one service module that was sold' using errcode = 'FS422';
  end if;
  perform public.agency_delivery_require_admin_user(p_owner_user_id);

  perform set_config('agency.delivery_write', 'on', true);
  insert into public.agency_client_tasks (client_id, template_key, module, category, title, description, required, waiting_on, sort_order, created_by)
    select p_client_id, t.template_key, t.module, t.category, t.title, t.description, t.required, t.waiting_on, t.sort_order, auth.uid()
    from public.agency_delivery_template(v_services) t
    on conflict (client_id, template_key) do nothing;
  get diagnostics v_count = row_count;
  update public.agency_clients set status = 'onboarding', status_changed_at = now(), services = v_services, owner_user_id = p_owner_user_id,
    target_launch_date = p_target_launch_date, onboarding_started_at = now(), onboarding_started_by = auth.uid()
    where id = p_client_id;
  perform public.agency_delivery_event(p_client_id, null, 'onboarding_started', jsonb_build_object('services', v_services, 'tasks_created', v_count, 'owner_user_id', p_owner_user_id, 'target_launch_date', p_target_launch_date));
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded', 'tasks_created', v_count);
end;
$$;

create or replace function public.agency_add_services(p_client_id uuid, p_expected_updated_at timestamp with time zone, p_services text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
  v_requested text[] := public.agency_delivery_clean_services(p_services);
  v_added text[];
  v_count integer;
begin
  if v_client.status = 'onboarding_not_started' then
    raise exception 'start onboarding first' using errcode = 'FS422';
  end if;
  v_added := coalesce((select array_agg(s order by s) from unnest(v_requested) s where not s = any(v_client.services)), '{}'::text[]);
  if cardinality(v_added) = 0 then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if p_expected_updated_at is null or v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  perform set_config('agency.delivery_write', 'on', true);
  insert into public.agency_client_tasks (client_id, template_key, module, category, title, description, required, waiting_on, sort_order, created_by)
    select p_client_id, t.template_key, t.module, t.category, t.title, t.description, t.required, t.waiting_on, t.sort_order, auth.uid()
    from public.agency_delivery_template(v_added) t where t.module <> 'core'
    on conflict (client_id, template_key) do nothing;
  get diagnostics v_count = row_count;
  update public.agency_clients set services = (select array_agg(distinct s order by s) from unnest(v_client.services || v_added) s) where id = p_client_id;
  perform public.agency_delivery_event(p_client_id, null, 'services_added', jsonb_build_object('added', v_added, 'tasks_created', v_count));
  perform public.agency_delivery_recheck_ready(p_client_id);
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded', 'tasks_created', v_count);
end;
$$;

create or replace function public.agency_add_task(p_request_id uuid, p_client_id uuid, p_title text, p_description text, p_category text, p_required boolean, p_waiting_on text, p_owner_user_id uuid, p_due_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
  v_existing public.agency_client_tasks;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'FS422';
  end if;
  select * into v_existing from public.agency_client_tasks t where t.id = p_request_id;
  if found then
    if v_existing.client_id <> p_client_id then
      raise exception 'request id already used' using errcode = 'FS422';
    end if;
    return jsonb_build_object('status', 'duplicate', 'task_id', v_existing.id);
  end if;
  if v_client.status = 'onboarding_not_started' then
    raise exception 'start onboarding first' using errcode = 'FS422';
  end if;
  if v_title is null or char_length(v_title) > 200 then
    raise exception 'give the task a title (up to 200 characters)' using errcode = 'FS422';
  end if;
  perform public.agency_delivery_require_admin_user(p_owner_user_id);
  perform set_config('agency.delivery_write', 'on', true);
  insert into public.agency_client_tasks (id, client_id, category, title, description, required, waiting_on, owner_user_id, due_date, sort_order, created_by)
  values (p_request_id, p_client_id, coalesce(p_category, 'other'), v_title, nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_required, false), coalesce(p_waiting_on, 'agency'), p_owner_user_id, p_due_date, 950, auth.uid());
  perform public.agency_delivery_event(p_client_id, p_request_id, 'task_added', jsonb_build_object('title', v_title, 'required', coalesce(p_required, false)));
  perform public.agency_delivery_recheck_ready(p_client_id);
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded', 'task_id', p_request_id);
end;
$$;

create or replace function public.agency_set_task_status(p_task_id uuid, p_expected_updated_at timestamp with time zone, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.agency_client_tasks;
  v_client public.agency_clients;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_task from public.agency_client_tasks t where t.id = p_task_id;
  if not found or not public.is_agency_admin() then
    raise exception 'task not found' using errcode = 'FS404';
  end if;
  v_client := public.agency_delivery_lock_client(v_task.client_id, null); -- serializes with launch
  select * into v_task from public.agency_client_tasks t where t.id = p_task_id for update;
  if p_status is null or p_status not in ('todo', 'in_progress', 'blocked', 'done', 'wont_do') then
    raise exception 'choose a valid status' using errcode = 'FS422';
  end if;
  if v_task.status = p_status and (p_status <> 'blocked' or v_task.blocked_reason is not distinct from v_reason) then
    return jsonb_build_object('status', 'duplicate', 'updated_at', v_task.updated_at);
  end if;
  if p_expected_updated_at is null or v_task.updated_at <> p_expected_updated_at then
    raise exception 'this task changed since it was loaded' using errcode = 'FS409';
  end if;
  if p_status in ('blocked', 'wont_do') and (v_reason is null or char_length(v_reason) > 500) then
    raise exception 'say why (up to 500 characters)' using errcode = 'FS422';
  end if;
  if p_status = 'wont_do' and v_task.required then
    raise exception 'a required task can''t be skipped' using errcode = 'FS422';
  end if;
  perform set_config('agency.delivery_write', 'on', true);
  update public.agency_client_tasks set
    status = p_status,
    blocked_reason = case when p_status = 'blocked' then v_reason end,
    wont_do_reason = case when p_status = 'wont_do' then v_reason end,
    completed_at = case when p_status = 'done' then now() end,
    completed_by = case when p_status = 'done' then auth.uid() end
    where id = p_task_id
    returning * into v_task;
  perform public.agency_delivery_event(v_task.client_id, p_task_id, 'task_status_changed', jsonb_build_object('title', v_task.title, 'to', p_status, 'reason', v_reason));
  perform public.agency_delivery_recheck_ready(v_task.client_id);
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_task.updated_at);
end;
$$;

create or replace function public.agency_set_task_details(p_task_id uuid, p_expected_updated_at timestamp with time zone, p_owner_user_id uuid, p_due_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.agency_client_tasks;
begin
  select * into v_task from public.agency_client_tasks t where t.id = p_task_id;
  if not found or not public.is_agency_admin() then
    raise exception 'task not found' using errcode = 'FS404';
  end if;
  perform public.agency_delivery_lock_client(v_task.client_id, null);
  select * into v_task from public.agency_client_tasks t where t.id = p_task_id for update;
  if v_task.owner_user_id is not distinct from p_owner_user_id and v_task.due_date is not distinct from p_due_date then
    return jsonb_build_object('status', 'duplicate', 'updated_at', v_task.updated_at);
  end if;
  if p_expected_updated_at is null or v_task.updated_at <> p_expected_updated_at then
    raise exception 'this task changed since it was loaded' using errcode = 'FS409';
  end if;
  perform public.agency_delivery_require_admin_user(p_owner_user_id);
  perform set_config('agency.delivery_write', 'on', true);
  update public.agency_client_tasks set owner_user_id = p_owner_user_id, due_date = p_due_date where id = p_task_id returning * into v_task;
  perform public.agency_delivery_event(v_task.client_id, p_task_id, 'task_details_changed', jsonb_build_object('title', v_task.title, 'owner_user_id', p_owner_user_id, 'due_date', p_due_date));
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_task.updated_at);
end;
$$;

create or replace function public.agency_set_client_details(p_client_id uuid, p_expected_updated_at timestamp with time zone, p_owner_user_id uuid, p_target_launch_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
begin
  if v_client.owner_user_id is not distinct from p_owner_user_id and v_client.target_launch_date is not distinct from p_target_launch_date then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if p_expected_updated_at is null or v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  perform public.agency_delivery_require_admin_user(p_owner_user_id);
  perform set_config('agency.delivery_write', 'on', true);
  update public.agency_clients set owner_user_id = p_owner_user_id, target_launch_date = p_target_launch_date where id = p_client_id;
  perform public.agency_delivery_event(p_client_id, null, 'details_changed', jsonb_build_object('owner_user_id', p_owner_user_id, 'target_launch_date', p_target_launch_date));
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

create or replace function public.agency_mark_ready_to_launch(p_client_id uuid, p_expected_updated_at timestamp with time zone)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
  v_gate jsonb;
begin
  if v_client.status in ('ready_to_launch', 'live', 'ongoing_management') then
    return jsonb_build_object('status', 'duplicate', 'client_status', v_client.status);
  end if;
  if v_client.status <> 'onboarding' then
    raise exception 'start onboarding first' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  v_gate := public.agency_delivery_gate(p_client_id);
  if not (v_gate->>'passes')::boolean then
    raise exception 'not ready: % of % required tasks done, % blocked', v_gate->>'required_done', v_gate->>'required', v_gate->>'blocked' using errcode = 'FS422';
  end if;
  perform set_config('agency.delivery_write', 'on', true);
  update public.agency_clients set status = 'ready_to_launch', status_changed_at = now() where id = p_client_id;
  perform public.agency_delivery_event(p_client_id, null, 'ready_to_launch', jsonb_build_object('gate', v_gate));
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- p_evidence: { "checks": [ { "key", "label", "status": "passed"|"failed"|"unverified", "critical": bool, "detail" } ... ],
--               "unverified_acknowledgement": text (required when any check is unverified) }
create or replace function public.agency_approve_launch(p_request_id uuid, p_client_id uuid, p_expected_updated_at timestamp with time zone, p_evidence jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
  v_existing public.agency_client_launches;
  v_gate jsonb;
  v_checks jsonb := p_evidence->'checks';
  v_ack text := nullif(btrim(coalesce(p_evidence->>'unverified_acknowledgement', '')), '');
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'FS422';
  end if;
  select * into v_existing from public.agency_client_launches l where l.client_id = p_client_id;
  if found then
    return jsonb_build_object('status', 'duplicate', 'launch_id', v_existing.id, 'approved_at', v_existing.approved_at);
  end if;
  if v_client.status <> 'ready_to_launch' then
    raise exception 'mark the client ready to launch first' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  v_gate := public.agency_delivery_gate(p_client_id);
  if not (v_gate->>'passes')::boolean then
    raise exception 'not ready: % of % required tasks done, % blocked', v_gate->>'required_done', v_gate->>'required', v_gate->>'blocked' using errcode = 'FS422';
  end if;
  if v_checks is null or jsonb_typeof(v_checks) <> 'array' or jsonb_array_length(v_checks) = 0
     or exists (select 1 from jsonb_array_elements(v_checks) c where coalesce(c->>'status', '') not in ('passed', 'failed', 'unverified') or coalesce(c->>'key', '') = '') then
    raise exception 'readiness evidence is missing or malformed' using errcode = 'FS422';
  end if;
  if exists (select 1 from jsonb_array_elements(v_checks) c where c->>'status' = 'failed' and coalesce((c->>'critical')::boolean, false)) then
    raise exception 'a critical readiness check failed - resolve it before launching' using errcode = 'FS422';
  end if;
  if exists (select 1 from jsonb_array_elements(v_checks) c where c->>'status' = 'unverified') and (v_ack is null or char_length(v_ack) < 10) then
    raise exception 'acknowledge the unverified checks in writing before launching' using errcode = 'FS422';
  end if;

  insert into public.agency_client_launches (id, client_id, approved_by, resulting_status, evidence)
  values (p_request_id, p_client_id, auth.uid(), 'live', jsonb_build_object('checks', v_checks, 'unverified_acknowledgement', v_ack, 'gate', v_gate));
  perform set_config('agency.delivery_write', 'on', true);
  update public.agency_clients set status = 'live', status_changed_at = now(), launched_at = now(), launched_by = auth.uid() where id = p_client_id;
  perform public.agency_delivery_event(p_client_id, null, 'launched', jsonb_build_object('launch_id', p_request_id, 'gate', v_gate, 'unverified_acknowledged', v_ack is not null));
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded', 'launch_id', p_request_id);
end;
$$;

create or replace function public.agency_move_to_ongoing(p_client_id uuid, p_expected_updated_at timestamp with time zone)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
begin
  if v_client.status = 'ongoing_management' then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if v_client.status <> 'live' then
    raise exception 'only a live client moves to ongoing management' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  perform set_config('agency.delivery_write', 'on', true);
  update public.agency_clients set status = 'ongoing_management', status_changed_at = now() where id = p_client_id;
  perform public.agency_delivery_event(p_client_id, null, 'moved_to_ongoing', '{}'::jsonb);
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- Explicit link to a Trackpr organization that is ALREADY Agency-managed.
-- Never adds to agency_organizations; one client per organization; links once.
create or replace function public.agency_link_client_organization(p_client_id uuid, p_expected_updated_at timestamp with time zone, p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.agency_clients := public.agency_delivery_lock_client(p_client_id, null);
begin
  if v_client.organization_id is not null then
    if v_client.organization_id = p_organization_id then
      return jsonb_build_object('status', 'duplicate');
    end if;
    raise exception 'this client is already linked to a Trackpr account' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_client.updated_at <> p_expected_updated_at then
    raise exception 'this client changed since it was loaded' using errcode = 'FS409';
  end if;
  if p_organization_id is null or not exists (select 1 from public.agency_organizations o where o.organization_id = p_organization_id) then
    raise exception 'that Trackpr account isn''t managed by the Agency' using errcode = 'FS422';
  end if;
  if exists (select 1 from public.agency_clients c where c.organization_id = p_organization_id) then
    raise exception 'that Trackpr account is already linked to another client' using errcode = 'FS409';
  end if;
  perform set_config('agency.delivery_write', 'on', true);
  update public.agency_clients set organization_id = p_organization_id, organization_linked_at = now(), organization_linked_by = auth.uid() where id = p_client_id;
  perform public.agency_delivery_event(p_client_id, null, 'organization_linked', jsonb_build_object('organization_id', p_organization_id));
  perform set_config('agency.delivery_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- Agency admins' own ids and emails, for owner pickers - visible to agency admins only.
create or replace function public.agency_admin_directory()
returns table (user_id uuid, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_agency_admin() then
    return;
  end if;
  return query select a.user_id, u.email::text from public.agency_admins a join auth.users u on u.id = a.user_id order by u.email;
end;
$$;

-- 6. Grants ---------------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.agency_delivery_lock_client(uuid, timestamp with time zone)',
    'public.agency_delivery_event(uuid, uuid, text, jsonb)',
    'public.agency_delivery_gate(uuid)',
    'public.agency_delivery_recheck_ready(uuid)',
    'public.agency_delivery_require_admin_user(uuid)',
    'public.agency_delivery_clean_services(text[])',
    'public.agency_delivery_template(text[])',
    'public.agency_clients_delivery_guard()',
    'public.agency_delivery_rows_guard()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.agency_start_onboarding(uuid, timestamp with time zone, text[], uuid, date)',
    'public.agency_add_services(uuid, timestamp with time zone, text[])',
    'public.agency_add_task(uuid, uuid, text, text, text, boolean, text, uuid, date)',
    'public.agency_set_task_status(uuid, timestamp with time zone, text, text)',
    'public.agency_set_task_details(uuid, timestamp with time zone, uuid, date)',
    'public.agency_set_client_details(uuid, timestamp with time zone, uuid, date)',
    'public.agency_mark_ready_to_launch(uuid, timestamp with time zone)',
    'public.agency_approve_launch(uuid, uuid, timestamp with time zone, jsonb)',
    'public.agency_move_to_ongoing(uuid, timestamp with time zone)',
    'public.agency_link_client_organization(uuid, timestamp with time zone, uuid)',
    'public.agency_admin_directory()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select set_config('agency.delivery_write', '', true);
commit;
