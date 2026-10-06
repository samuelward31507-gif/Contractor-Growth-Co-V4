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
