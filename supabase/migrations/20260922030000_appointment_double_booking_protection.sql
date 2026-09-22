-- Phase 1 Scheduling Foundation, Stage 1: database-level double-booking
-- protection for public.appointments.
--
-- WHY: lib/appointments/overlap.ts's checkAppointmentOverlap() (added in an
-- earlier production-readiness pass) is a plain SELECT-then-decide check
-- with no lock, no transaction, and no DB constraint backing it - its own
-- header comment already says as much. Today that race is rare in practice
-- (a human typing into the appointment form is a natural rate limit), but
-- an AI-driven booking flow removes that limit entirely, making the
-- same-slot race a real, expected occurrence. checkAppointmentOverlap()
-- stays exactly as-is as the fast, friendly pre-check (a clean "that slot
-- was just taken" message beats a raw constraint-violation error) - this
-- migration adds the actual guarantee underneath it.
--
-- WHY organization_id + tstzrange, not per-technician: appointments has no
-- assignee/technician column (confirmed by inspection, matches
-- overlap.ts's own documented reasoning) - this schema only supports
-- organization-wide scheduling today, so the exclusion constraint's
-- granularity matches exactly what the application-level check already
-- enforces. Adding per-technician granularity later would need its own
-- migration once that column exists; this one is deliberately scoped to
-- today's actual data model, not a hypothetical future one.
--
-- WHY this exact status list, matching checkAppointmentOverlap() exactly:
-- scheduled/confirmed/completed occupy a slot; cancelled (never happened)
-- and no_show (customer didn't arrive, contractor's time is free again)
-- never do. Any two rows outside this status set - or in different
-- organizations - can freely share a time range; the constraint's own
-- WHERE clause and organization_id term encode both of those exemptions
-- directly, so no additional application logic is needed to preserve them.
--
-- btree_gist is required because a GiST exclusion constraint needs
-- operator classes for the equality term (organization_id, a uuid) that
-- vanilla PostgreSQL's built-in GiST support doesn't provide on its own -
-- btree_gist supplies exactly that "treat btree-comparable types as GiST-
-- indexable for equality" bridge. Confirmed available on this Supabase
-- project (default_version 1.7) via the project's own extension catalog
-- before writing this migration - not assumed.

create extension if not exists btree_gist;

alter table public.appointments
  add constraint appointments_no_overlap
  exclude using gist (
    organization_id with =,
    tstzrange(start_at, end_at) with &&
  )
  where (status in ('scheduled', 'confirmed', 'completed'));
