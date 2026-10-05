-- Rollback for lead_sms_intake_unique.sql (P0 A3). Run by a person (the MCP
-- SQL tools hang on DROP statements - see README).
drop index if exists public.leads_one_new_sms_intake_per_contact;
