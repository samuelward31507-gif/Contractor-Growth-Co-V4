-- Rollback for founder_finance.sql - NON-DESTRUCTIVE.
--
-- Removes every write path and the three aggregate reads (the functions), so
-- nothing can record, correct or void a financial record, and the founder
-- can no longer read Stripe or Agency totals.
--
-- It KEEPS: every expense, recurring cost, income record, cash balance and
-- audit event; the tables' RLS (founders read only their own rows) and
-- select-only grants; and the guard triggers - so with the functions gone
-- the records are read-only to everyone, including the service role.
-- It also keeps founder_currency_minor_units(), a pure lookup the tables'
-- decimal-place checks use. revenue_events, agency_clients and
-- founder_mrr_entries were never changed and are not touched here.
--
-- Idempotent. Re-applying founder_finance.sql restores the functions.

begin;

drop function if exists public.founder_record_expense(uuid, text, text, text, numeric, text, date, date, date, uuid, date);
drop function if exists public.founder_mark_expense_paid(uuid, timestamp with time zone, date);
drop function if exists public.founder_correct_expense(uuid, timestamp with time zone, text, text, text, numeric, text, date, date, date, text);
drop function if exists public.founder_void_expense(uuid, text);
drop function if exists public.founder_create_recurring_cost(uuid, text, text, text, numeric, text, text, date);
drop function if exists public.founder_correct_recurring_cost(uuid, timestamp with time zone, text, text, text, text);
drop function if exists public.founder_end_recurring_cost(uuid, timestamp with time zone, date);
drop function if exists public.founder_void_recurring_cost(uuid, text);
drop function if exists public.founder_record_income(uuid, text, text, text, numeric, text, date, text, text);
drop function if exists public.founder_correct_income(uuid, timestamp with time zone, text, text, text, numeric, text, date, text, text, text);
drop function if exists public.founder_void_income(uuid, text);
drop function if exists public.founder_record_cash_balance(uuid, text, numeric, text, date, text);
drop function if exists public.founder_void_cash_balance(uuid, text);
drop function if exists public.founder_stripe_revenue_summary(timestamp with time zone, timestamp with time zone);
drop function if exists public.founder_stripe_unrecovered_invoices();
drop function if exists public.founder_stripe_verified_exponent(text);
drop function if exists public.founder_contracted_mrr();
drop function if exists public.founder_finance_lock_expense(uuid, timestamp with time zone);
drop function if exists public.founder_finance_audit(text, uuid, text, text, jsonb, jsonb);
drop function if exists public.founder_finance_check(numeric, text, text, text, text);
drop function if exists public.founder_finance_reason(text);
drop function if exists public.founder_finance_today();

commit;

-- NOT RUN BY DEFAULT - permanently deletes every founder financial record and
-- its history. Needs explicit authorization:
--
--   drop table public.founder_finance_events, public.founder_expenses, public.founder_recurring_costs,
--     public.founder_income_receipts, public.founder_cash_balances;
--   drop function public.founder_finance_rows_guard();
--   drop function public.founder_finance_events_guard();
--   drop function public.founder_currency_minor_units(text);
