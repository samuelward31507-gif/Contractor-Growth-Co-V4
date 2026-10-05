-- P0 A3: at most one unqualified SMS-intake lead per contact.
--
-- STATUS: PENDING for Production - applied to TEST only. See
-- supabase/pending/README.md.
--
-- WHY: lib/leads/intake.ts (A1) reuses a contact's open lead and only
-- inserts a new 'sms_inbound' lead when it finds none. Two first texts from
-- a brand-new number arriving at the same moment can both find none and
-- both insert - two open leads for one contact. Same race, same remedy as
-- contacts (resolveOrCreateContact): a partial unique index, and the
-- caller treats 23505 as "the other delivery won" and re-reads the winner.
--
-- SCOPE (deliberately narrow): only rows with source 'sms_inbound' AND
-- status 'new'. 'sms_inbound' is written only by A1's automated SMS intake
-- (never offered to people creating leads), and the intake reuses an
-- existing open lead before ever inserting, so no legitimate insert is
-- refused. Manual leads, other sources, and every lead once it leaves
-- 'new' (qualified, won, lost, ...) are unconstrained - a contact can still
-- get a new SMS lead after the earlier one closes, and a contractor can
-- still create any number of leads by hand.
--
-- Idempotent. Rollback: lead_sms_intake_unique_rollback.sql.

create unique index if not exists leads_one_new_sms_intake_per_contact
  on public.leads (organization_id, contact_id)
  where source = 'sms_inbound' and status = 'new' and contact_id is not null;
