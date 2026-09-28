-- Trackpr Phase 1B - Invoice Foundation GRANT NARROWING (follow-up).
--
-- STATUS: PENDING. Standalone follow-up to invoice_foundation (production
-- ledger version 20260928162500). Applied deliberately, by a person, via the
-- same mechanism; never by db push.
--
-- Why: invoice_foundation's GRANT statements were additive on top of this
-- project's default privileges (pg_default_acl grants arwdDxtm - every table
-- privilege - to anon, authenticated and service_role on every new table in
-- public). The privilege layer therefore did not match the approved model
-- even though RLS and the triggers already enforce it. Verified against
-- production on 2026-09-28 before writing this file:
--
--   invoices          anon, authenticated, service_role: ALL
--   customer_payments anon, authenticated, service_role: ALL
--
-- This script changes ONLY table privileges on those two tables, exactly as
-- approved:
--
--   revoke ALL            on public.invoices           from anon
--   revoke ALL            on public.customer_payments  from anon
--   revoke DELETE         on public.invoices           from authenticated
--   revoke UPDATE, DELETE on public.customer_payments  from authenticated
--
-- Preserved untouched: every service_role privilege, every RLS policy, every
-- trigger and function, every other table, and authenticated's remaining
-- privileges (select/insert/update on invoices; select/insert on
-- customer_payments; plus REFERENCES/TRIGGER/TRUNCATE, which the approval
-- did not name and which every other public table also grants).
--
-- Idempotent: REVOKE of an already-absent privilege is a no-op.

revoke all on table public.invoices from anon;
revoke all on table public.customer_payments from anon;
revoke delete on table public.invoices from authenticated;
revoke update, delete on table public.customer_payments from authenticated;
