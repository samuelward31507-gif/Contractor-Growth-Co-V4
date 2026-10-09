-- Rollback for agency_client_delivery.sql - NON-DESTRUCTIVE.
--
-- Removes every delivery write path (the functions), so nothing can start
-- onboarding, change a task, approve a launch or link a Trackpr account. The
-- Phase 2 build (handoffs page, confirm) keeps working: agency_clients keeps
-- its columns, and a newly confirmed client still starts at
-- onboarding_not_started.
--
-- It KEEPS: every task, event and launch record, every lifecycle column and
-- value on agency_clients (status, owner, services, launch and link times,
-- organization link), the wider status check (existing rows may already be
-- past onboarding), RLS policies, select-only grants, and the guard triggers
-- that keep terms immutable and history append-only.
--
-- Idempotent. Re-applying agency_client_delivery.sql restores the functions.

begin;

drop function if exists public.agency_start_onboarding(uuid, timestamp with time zone, text[], uuid, date);
drop function if exists public.agency_add_services(uuid, timestamp with time zone, text[]);
drop function if exists public.agency_add_task(uuid, uuid, text, text, text, boolean, text, uuid, date);
drop function if exists public.agency_set_task_status(uuid, timestamp with time zone, text, text);
drop function if exists public.agency_set_task_details(uuid, timestamp with time zone, uuid, date);
drop function if exists public.agency_set_client_details(uuid, timestamp with time zone, uuid, date);
drop function if exists public.agency_mark_ready_to_launch(uuid, timestamp with time zone);
drop function if exists public.agency_approve_launch(uuid, uuid, timestamp with time zone, jsonb);
drop function if exists public.agency_move_to_ongoing(uuid, timestamp with time zone);
drop function if exists public.agency_link_client_organization(uuid, timestamp with time zone, uuid);
drop function if exists public.agency_admin_directory();
drop function if exists public.agency_delivery_recheck_ready(uuid);
drop function if exists public.agency_delivery_gate(uuid);
drop function if exists public.agency_delivery_event(uuid, uuid, text, jsonb);
drop function if exists public.agency_delivery_lock_client(uuid, timestamp with time zone);
drop function if exists public.agency_delivery_require_admin_user(uuid);
drop function if exists public.agency_delivery_clean_services(text[]);
drop function if exists public.agency_delivery_template(text[]);

commit;

-- NOT RUN BY DEFAULT - each needs explicit authorization:
--
-- (a) Permanently delete all delivery history (tasks, events, launches):
--   drop table public.agency_client_launches, public.agency_client_events, public.agency_client_tasks;
--   drop function public.agency_delivery_rows_guard();
--
-- (b) Remove the lifecycle columns from agency_clients (loses status, owner,
--     services, launch and link records) and restore the Phase 2 status check:
--   drop trigger agency_clients_delivery_guard on public.agency_clients; ...
