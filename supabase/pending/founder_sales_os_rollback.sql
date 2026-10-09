-- Rollback for founder_sales_os.sql - NON-DESTRUCTIVE.
--
-- Purpose: let the previous application build (before the sales OS) write
-- deals again, without losing anything recorded. It removes the write paths
-- (functions, the stage guard) and widens the stage and won checks so both
-- the old and new values are accepted.
--
-- It KEEPS: every deal and every column (prospect fields, setup/monthly
-- terms, stage history fields), the founder_deal_activities table with all
-- its rows, its RLS policy, its select-only grant and its append-only
-- trigger. Stage values are NOT rewritten.
--
-- Idempotent. Re-applying founder_sales_os.sql afterwards restores the
-- functions and checks (it maps any legacy stages written meanwhile 1:1, and
-- stops if a win was recorded without separate setup/monthly terms).

begin;

drop function if exists public.founder_change_deal_stage(uuid, uuid, text, timestamp with time zone, timestamp with time zone, numeric, numeric, text, date, text);
drop function if exists public.founder_log_deal_activity(uuid, uuid, text, timestamp with time zone, text, text, timestamp with time zone, text, timestamp with time zone);
drop function if exists public.founder_void_deal_activity(uuid, text);
drop function if exists public.founder_sales_apply_stage(public.founder_deals, uuid, text, timestamp with time zone, numeric, numeric, text, date, text);
drop function if exists public.founder_sales_lock_deal(uuid);
drop function if exists public.founder_sales_is_duplicate(uuid, uuid);
drop function if exists public.founder_sales_stage_rank(text);

drop trigger if exists founder_deals_sales_guard on public.founder_deals;
drop function if exists public.founder_deals_sales_guard();

alter table public.founder_deals drop constraint if exists founder_deals_stage_check;
alter table public.founder_deals add constraint founder_deals_stage_check check (stage in (
  'lead', 'contacted', 'meeting_booked', 'demo_proposal', 'negotiation', 'won', 'lost',
  'identified', 'qualified', 'outreach', 'replied', 'meeting_held', 'proposal_sent'
));
alter table public.founder_deals drop constraint if exists founder_deals_won_terms;
alter table public.founder_deals drop constraint if exists founder_deals_won_complete_compat;
alter table public.founder_deals add constraint founder_deals_won_complete_compat check (
  stage <> 'won' or (won_on is not null and (won_amount is not null or (won_setup_fee is not null and won_monthly_fee is not null)))
);
alter table public.founder_deals drop constraint if exists founder_deals_lost_reason_required;
alter table public.founder_deals alter column stage set default 'lead';

commit;

-- NOT RUN BY DEFAULT - each needs explicit authorization:
--
-- (a) Show deals in the previous build's stage names (lossy for the three
--     stages it never had: qualified, replied and meeting_held):
--   update public.founder_deals set stage = case stage
--     when 'identified' then 'lead' when 'qualified' then 'lead'
--     when 'outreach' then 'contacted' when 'replied' then 'contacted'
--     when 'meeting_held' then 'meeting_booked' when 'proposal_sent' then 'demo_proposal'
--     else stage end;
--
-- (b) Destructive cleanup - permanently deletes the recorded sales history
--     and the new deal fields:
--   drop table public.founder_deal_activities;
--   drop function public.founder_deal_activities_append_only();
--   alter table public.founder_deals drop column source, drop column trade, ...;
