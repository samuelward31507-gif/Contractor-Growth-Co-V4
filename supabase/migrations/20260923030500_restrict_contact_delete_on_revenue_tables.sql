-- Preserve historical revenue records: a contact with any appointment,
-- estimate, or job can no longer be deleted at all, so those records can
-- never lose their customer link. Non-revenue CRM metadata (conversations,
-- ai_interactions, review_requests, referral_requests, leads) intentionally
-- keeps its existing ON DELETE SET NULL behavior - only the three tables
-- named in the product requirement (preserve appointments/estimates/jobs/
-- revenue records) are tightened here.
--
-- deleteContact() and deleteLead() (app/(app)/contacts/actions.ts,
-- app/(app)/leads/actions.ts) already catch Postgres error 23503 and
-- return a friendly "this contact can't be deleted yet..." message - that
-- handling was already written for exactly this constraint type, it just
-- never fired because the constraint was SET NULL instead of RESTRICT.
-- No application code changes are required for this fix to take effect.

alter table public.appointments
  drop constraint appointments_contact_id_fkey,
  add constraint appointments_contact_id_fkey
    foreign key (contact_id) references public.contacts(id) on delete restrict;

alter table public.estimates
  drop constraint estimates_contact_id_fkey,
  add constraint estimates_contact_id_fkey
    foreign key (contact_id) references public.contacts(id) on delete restrict;

alter table public.jobs
  drop constraint jobs_contact_id_fkey,
  add constraint jobs_contact_id_fkey
    foreign key (contact_id) references public.contacts(id) on delete restrict;
