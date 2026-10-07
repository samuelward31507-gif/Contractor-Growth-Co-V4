-- Final Batch 2: SMS consent captured with a public lead-capture submission.
--
-- STATUS: PENDING - not applied anywhere. Must be applied BEFORE the code
-- that reads it is deployed (the outbound gate selects this column; a
-- database without it fails closed and blocks lead-scoped automated SMS).
-- See supabase/pending/README.md.
--
-- WHY a column (and not audit_log): the outbound gate must decide, on every
-- automated send, whether the opportunity it is about was captured without
-- affirmative SMS consent. audit_log cannot answer that reliably - the
-- absence of a consent row cannot distinguish "captured by the public form
-- without consent" from every lead that never went through the form (manual,
-- inbound SMS, missed call, referral, all existing rows), leads.source is
-- caller-supplied by the form so it cannot identify form leads either, and a
-- log written after the lead insert leaves a window in which the lead exists
-- without its consent state. The state is written in the same insert as the
-- lead.
--
-- VALUES (deliberately separate from contacts.sms_opt_out, which stays the
-- one STOP/START flag and is never written from here):
--   null           - not captured through the public form (every existing
--                    row; manual and other intake paths). Behavior unchanged.
--   'granted'      - the form sent affirmative SMS consent.
--   'declined'     - the form sent an explicit "no".
--   'not_provided' - the form sent no consent field, or an unrecognized value.
-- Automated SMS for a lead is allowed only when this is null or 'granted'.
--
-- No backfill: existing leads stay null (never retroactively non-consented).
-- Idempotent. Rollback: lead_sms_consent_rollback.sql.

alter table public.leads add column if not exists sms_consent text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_sms_consent_check' and conrelid = 'public.leads'::regclass) then
    alter table public.leads
      add constraint leads_sms_consent_check check (sms_consent is null or sms_consent in ('granted', 'declined', 'not_provided'));
  end if;
end $$;

comment on column public.leads.sms_consent is
  'SMS consent captured by the public lead-capture form for this lead: null = not captured via the form (unchanged behavior), granted, declined, not_provided. Automated SMS only when null or granted. Distinct from contacts.sms_opt_out (STOP/START).';
