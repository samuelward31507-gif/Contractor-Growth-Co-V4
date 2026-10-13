-- Web-form intake: at most one 'new' web-form lead per contact.
--
-- STATUS: PENDING - not applied anywhere. Apply by a person, as one
-- transaction, TEST first - never with `supabase db push` (see README.md).
-- Order: may be applied before or after the code that writes it. The code
-- (lib/leads/intake.ts) falls back to inserting without the marker when the
-- column is missing, so either order is safe; protection starts once this is
-- applied.
--
-- WHY: the public capture route (app/api/leads/capture/[token]) checks for
-- an existing lead and then inserts - two simultaneous submissions for a new
-- contact both pass the check and create two leads (two lead.created events,
-- two first follow-ups). leads.source is caller-supplied free text, so no
-- index can single out web-form leads by it. intake_channel is set only by
-- the route itself.
--
-- WHAT:
--   * leads.intake_channel text, nullable, no default, no backfill; the only
--     allowed value is 'web_form'. Every existing row stays null.
--   * partial unique index leads_one_new_web_form_intake_per_contact on
--     (organization_id, contact_id) where intake_channel = 'web_form' and
--     status = 'new' - the same shape as leads_one_new_sms_intake_per_contact.
--     A losing concurrent insert gets 23505 and resolveLeadForIntake reuses
--     the winner's lead.
--
-- RISK: every existing row has intake_channel null, so the index cannot
-- conflict with existing data. CREATE INDEX (not CONCURRENTLY - it runs in a
-- transaction) holds a SHARE lock on leads while it builds; the predicate
-- matches no existing rows. RLS unchanged. Idempotent.
-- Rollback: lead_web_form_intake_unique_rollback.sql.

begin;

alter table public.leads add column if not exists intake_channel text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_intake_channel_check') then
    alter table public.leads add constraint leads_intake_channel_check check (intake_channel is null or intake_channel = 'web_form');
  end if;
end $$;

create unique index if not exists leads_one_new_web_form_intake_per_contact
  on public.leads (organization_id, contact_id)
  where intake_channel = 'web_form' and status = 'new' and contact_id is not null;

commit;
