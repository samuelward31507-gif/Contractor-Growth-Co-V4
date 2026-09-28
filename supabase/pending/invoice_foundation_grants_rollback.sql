-- Trackpr Phase 1B - Invoice Foundation GRANT NARROWING ROLLBACK.
--
-- Restores the exact privilege state observed in production on 2026-09-28
-- before invoice_foundation_grants.sql: anon, authenticated and service_role
-- each held ALL (select, insert, update, delete, truncate, references,
-- trigger) on both tables, as produced by the project's default privileges.
-- Only the four revoked privileges are re-granted; nothing else changes.
--
-- Idempotent: GRANT of an already-present privilege is a no-op.

grant all on table public.invoices to anon;
grant all on table public.customer_payments to anon;
grant delete on table public.invoices to authenticated;
grant update, delete on table public.customer_payments to authenticated;
