-- Pass 5B: Appointment Confirmation + Automated No-Show Protection.
--
-- CONFIRMATION: the existing appointments.status enum already has a
-- 'confirmed' value, and the Pass 5 audit's own finding was that nothing
-- ever set it except a manual contractor click - reused as-is here, not
-- replaced. What the existing model genuinely cannot represent is the
-- distinction between "confirmation not yet requested" and "requested, no
-- response yet" (both look identical as status='scheduled'), and there is
-- no authoritative record of WHEN a confirmation actually happened.
--
--  - confirmed_at: the authoritative confirmation timestamp. Necessary
--    because status='confirmed' alone conflates "the customer just replied
--    YES" with "a contractor clicked Confirm three weeks ago" - and because
--    Part A5's reschedule-invalidation rule needs something to null out when
--    a confirmed appointment's time changes (see actions.ts/booking.ts).
--  - confirmation_requested_at: set only when a confirmation-asking reminder
--    genuinely reached the customer (lib/automation/appointment-reminders.ts).
--    Materializes a fact the existing appointment.reminder automation_events
--    row already implies, onto the row itself, so the dashboard Attention
--    engine and the no-show-adjacent "awaiting confirmation" surface can
--    query it directly - a single indexed column, not a join against
--    automation_events on every dashboard load. Deliberately NOT a
--    confirmation_request_id or attempt-count column: idempotency for "don't
--    ask twice" already comes for free from the existing reminder
--    automation's own event-level idempotency key
--    (appointment.reminder:{id}:{start_at}), and this pass is a single-touch
--    ask, not a multi-attempt nurture sequence - a second column for that
--    would track nothing this codebase actually needs yet.
--
-- NO-SHOW SCAN INDEX: the automated no-show scan (see
-- lib/automation/no-show-detection.ts) queries across every organization at
-- once for appointments whose end_at has passed the grace period while
-- status is still 'scheduled'/'confirmed' - the same "index the actual query
-- shape" precedent the opportunities migration's own dormant-customer index
-- already established. A partial index (only non-terminal appointments) so
-- it never grows with the far larger set of completed/cancelled/no_show
-- history.

alter table public.appointments
  add column if not exists confirmed_at timestamp with time zone,
  add column if not exists confirmation_requested_at timestamp with time zone;

create index if not exists idx_appointments_noshow_scan
  on public.appointments (end_at)
  where status in ('scheduled', 'confirmed');
