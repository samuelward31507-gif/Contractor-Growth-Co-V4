-- Rollback for founder_command_center.sql. Deploy code that no longer reads
-- these first (the current code tolerates their absence: /founder returns
-- 404). Drops every founder task, deal, MRR entry and review - run by a
-- person, it contains DROP. Idempotent.
begin;
drop table if exists public.founder_reviews;
drop table if exists public.founder_mrr_entries;
drop table if exists public.founder_items;
drop table if exists public.founder_deals;
drop function if exists public.founder_items_guard();
drop function if exists public.founder_owner_immutable();
drop function if exists public.is_founder();
drop table if exists public.founder_users;
commit;
