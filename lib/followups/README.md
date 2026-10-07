# Obligation engine (P0 A4 → P0-B B2.1)

An **obligation** is something Trackpr owes a customer. In B2.1 it is a row in `public.followups`. Its `stage` names its **kind**.

| File | What |
|---|---|
| `kinds.ts` | The **descriptor registry**: the light half of each kind. It holds the stage, catalog automation, event type, workflow name, subject type and touch-key format, and is safe to import anywhere (including by producers). |
| `engine.ts` | The kind **handlers** (the runtime half: subject load, still-owed check, message, gate options, terminal gate reasons) and the **kind-agnostic dispatcher**: `dispatchDueObligations`, `dispatchObligation`, `retryObligationTouch`. |
| `producer.ts` | `ensureObligation(stage, …)`, the generic producer. It records intent only and never sends. |
| `config.ts` | Cadence. Still the only source of cadence. |
| `state.ts` / `store.ts` | The state machine and conditional writes. Both are unchanged from A4. |

## Registered kinds

There is exactly one: **`lead_no_reply`** (A4). Every A4 value is preserved:

- states and `waiting_on` / `next_action`;
- cadence (24h / 72h / 168h);
- touch numbering;
- the touch key `followup.touch:<followup_id>:<touch>`;
- reasons, gate options and terminal reasons;
- the `lead-followup-sequence` automation and the `lead_followup_touch` workflow.

The A4 names (`dispatchDueFollowups`, `dispatchFollowup`, `retryFollowupTouch`, `ensureLeadFollowup`) are aliases of the generic functions.

Lookups are by exact key only (`hasOwnProperty`). An unregistered stage is never defaulted:

- the dispatcher returns `error: unregistered_obligation_kind:<stage>` without claiming the row;
- the producer records nothing.

## Dispatch

1. **Claim with a lease.** A conditional update picks one winner. Unregistered kinds are not claimed.
2. **Load the kind's subject.** If the subject is gone, the obligation exits.
3. **Load the subject contact's B1 lifecycle snapshot** (`lib/lifecycle`, as of now) and derive the lifecycle. If the read fails, the obligation is released to `scheduled` with the same due time, unconsumed, and nothing is recorded or sent. A retry with a failed read fails the execution.
4. **Ask `kind.stillOwed`.** For `lead_no_reply`:
   - a customer reply since the obligation began, read from the snapshot's message timeline at microsecond precision, completes it. If the 200-message window is full and newer than the anchor, A4's own targeted read answers instead.
   - otherwise A3's `checkLifecycleEligibility` decides, with its own reads, unchanged.
5. **Dormancy, then business hours.** A touch more than 48 hours late is paused as dormant. A touch outside business hours is deferred unconsumed.
6. **Record the touch.** The automation event uses the kind's touch key. B0's atomic `start_workflow_execution` claims the execution. Then the outbound gate, then the send. A send failure is a failed execution, retried by A2.
7. **Advance** on the cadence, or complete or exit.

## What is still A4-specific (until B2.2 / B2.3)

- **Subjects are leads.** The schema carries only `lead_id` with `unique (lead_id, stage)`.
- **`FollowupStage` / the `followups.stage` CHECK** allow only `lead_no_reply`. A new kind needs a migration.
- **The A3 rule still does its own reads** inside the `lead_no_reply` handler. Moving it onto the snapshot is a later step.
- **`lib/lifecycle` consumers.** This engine is the only module outside `lib/lifecycle` allowed to import the B1 model; `lib/lifecycle/statuses.test.ts` allowlists it.

Tests:

- `followups.test.ts`: A4, unchanged.
- `obligations.test.ts`: B2.1. It covers the registry, the producer path, snapshot ordering and fail-closed behaviour, and A4 parity characterization.

## Shared touch runtime (P0-B B2.4)

Every Trackpr-composed touch, persisted or derived, now runs the same universal steps. They take a kind's identity and policy values only, and never branch on kind names.

| Step | Where |
|---|---|
| `verifyLifecycle` | `engine.ts`. The B1 snapshot for the subject contact, scoped by organization and contact, as of now, then derived. A failed read means nothing may act. |
| `claimTouch` | `engine.ts`. Records the touch's idempotency key, then starts the execution through B0's atomic start. |
| `executeTouch` | `engine.ts`. Outbound gate → send → record on the execution (the A2 contract). It holds the only send call; the A4 suite pins that call to this file. |

Two drivers feed those steps:

- **Persisted:** this file's dispatcher. It handles the row lease, deferral, dormancy and state, and is unchanged.
- **Derived:** `lib/automation/touch-runtime.ts` (`runDerivedTouch`). It runs a fixed pipeline: kill switch → payment (policy) → still due → soft claim → B1 verification → still owed → stale policy → claim → compose → gate → send → record.

Each kind plugs in through a `DerivedTouchAdapter`: pure functions of the work item (subject, legacy key, due check, due time, still-owed check, payload, message, gate options, result ids) plus policy values.

The first derived kind is customer reactivation (`CUSTOMER_REACTIVATION_ADAPTER`). Its existing scan is still its producer. Tests: `lib/automation/touch-runtime.test.ts`.

### Contract extension (P0-B B2.5a)

- **Execution context:** `{ triggerSource: "event" | "manual" }` describes how a run was initiated. It reaches B0's start through `claimTouch`, and defaults to `"event"`. `"retry"` stays A2's alone.
- **Audit fields:** `auditFields(item)` returns the kind's flat scalar ids, recorded on every execution of a touch after the runtime's outcome fields. A field that would overwrite an outcome field (`RUNTIME_OUTCOME_FIELDS`), or that isn't a scalar, is rejected before anything is recorded.
- **Subject resolution:** the B1 step tells two failures apart:
  - **unknown** (a failed read): fail closed, record nothing, stay eligible;
  - **known missing** (B1's `contact_not_found`): the kind's `missingSubject` policy decides:
    - `record_blocked`: claim the key and record a blocked `contact_not_found` execution, with no conversation, message, gate or send;
    - `skip`: record nothing.
- **Stale policy:**
  - `{ mode: "none" }`, or
  - `{ mode: "record_blocked", audit: "audit_fields" | "payload" }`: recorded through the runtime's own `recordBlockedTouch`, so the trigger source is kept. `payload` is customer reactivation's legacy value.
- **`retryDerivedTouch`:** the shared A2 retry of a derived touch. A2 still decides, accounts the attempt and starts the `"retry"` execution. The runtime then runs subject + B1 → still owed → the shared gate/send spine, with A2's ops. There is no stale check on retry.

### Estimate follow-up (P0-B B2.5)

Estimate follow-up is the second derived kind (`ESTIMATE_FOLLOWUP_ADAPTER` in `lib/automation/estimate-followups.ts`).

- **Producer** (unchanged order): handle expiry first, then hand the touch to the runtime.
  - Expiry is lifecycle-only and never enters the runtime: sent → expired, plus the `estimate.expired` event and the `estimate_expired_lifecycle` execution.
  - The runtime then runs: kill switch → still due → B1 → K5-3 overdue (`record_blocked`, `{estimate_id, occurrence}`) → legacy key `estimate.followup:<id>:<occurrence>` + B0 → gate → send.
- **Run Now** passes `{ triggerSource: "manual" }`.
- **A2 retry:** `retryEstimateWorkflow` keeps its estimate-specific checks (reference, estimate, occurrence, expiry retry) and runs the touch through `retryDerivedTouch`.
- **Preview** stays read-only.
- **Tests:** `lib/automation/estimate-followups.runtime.test.ts`.

### Appointment reminders (P0-B B2.6)

Appointment reminders are the third derived kind (`APPOINTMENT_REMINDER_ADAPTER` in `lib/automation/appointment-reminders.ts`).

- **Identity:** one reminder per (appointment, `start_at`), under the legacy key `appointment.reminder:<id>:<start_at>`. A reschedule is a new reminder.
- **Due:** inside the organization's lead-time window, behind the existing stability guard (`isReminderDue`). There's no lateness rule (`stale: none`).
- **Status:** the gate re-checks the appointment is still scheduled/confirmed.
- **Run Now** passes `{ triggerSource: "manual" }`.
- **`confirmation_requested_at`** stays in the producer. It's written only after the runtime reports `sent`, and only when the reminder asked for confirmation. A write error is logged; the reminder still counts as sent.
- **A2 retry:** `retryAppointmentReminder` keeps its reference and lookup checks and runs the reminder through `retryDerivedTouch`. A retry never writes `confirmation_requested_at`.
- **Tests:** `lib/automation/appointment-reminders.runtime.test.ts`.
