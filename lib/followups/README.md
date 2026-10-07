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

### Claimed verification and the audit-record policy (P0-B B2.7a)

Two generic contract additions. No kind uses either beyond its default yet. Invoice reminders are **not** migrated in B2.7a; that is B2.7.

**`verifyClaimed(service, item, facts)`** is a new adapter step. The derived pipeline is now:

claim (key + B0 start) → **verifyClaimed** → compose → gate → send → record.

B1 and the still-owed check still run before the claim.

- **Why after the claim:** a check after the claim reads the truth as of a moment when no concurrent run can also be sending this touch. The key is used and the execution has started, so a block is recorded rather than silently skipped, and the same touch is never re-attempted.
- **Verdicts:**
  - `verified`: its `facts`, `contactId` and `leadId` replace the pre-claim ones for compose, the conversation and the gate.
  - `blocked`: the event and execution stand. The execution completes as blocked (`reason`, plus the kind's audit fields or the verdict's own). Nothing is composed, gated or sent, and the key stays used.
  - `unknown`, a throw, or an unrecognised verdict: the execution **fails** (`claimed_verification_failed: …`). It is never blocked and never sent.
- **Not an authorizer:** the outbound gate still decides every send.
- **Existing kinds** (customer reactivation, estimate follow-up, appointment reminders) use `unchangedAfterClaim(subject)`, a pass-through that keeps the pre-claim facts and subject. Their behaviour is byte-identical.
- **A2 retry:** `retryDerivedTouch` applies the same verification after still-owed. A blocked verdict completes the retry execution; an unknown verdict fails it.

**`policy.auditRecord`** sets how much every execution record of a kind may hold (`AuditRecordPolicy` in `engine.ts`).

| | `{ shape: "full" }` | `{ shape: "minimal", failureMessage }` |
|---|---|---|
| Blocked | `should_send: false`, `blocked_reason`, `blocked_detail` | `should_send: false`, `blocked_reason` (no detail) |
| Sent | `should_send: true`, message, conversation and provider ids | `should_send: true`, `sent: true` |
| Send failure | the provider's error | the kind's fixed `failureMessage`, never the provider's text |

- **Full** is every existing kind's record, unchanged, and A4 uses `FULL_AUDIT_RECORD`.
- **Validation:** the policy is checked before anything is claimed. A missing policy, an unknown shape, or `minimal` without a message fails the run; there is no fallback shape.
- **`sent`** joins `RUNTIME_OUTCOME_FIELDS`, so a kind's audit fields can't forge it.

### Invoice reminders (P0-B B2.7)

Invoice reminders are the fourth derived kind (`INVOICE_REMINDER_ADAPTER` in `lib/automation/invoice-reminders.ts`), and the first to use B2.7a's claimed verification and the minimal record.

**The producer keeps every invoice-specific rule:**
- **Organizations:** opted in only (off by default), live, payment active, not paused.
- **Send window:** 09:00–18:00 in the organization's timezone, UTC when it has none.
- **Candidates:** `sent` / `partially_paid`, 1–20 days overdue, contact required, positive balance, oldest due date first.
- **Stages:** 1 / 7 / 14 (1–6, 7–13 and 14–20 days overdue). No backfill.
- **Delivery:** a `invoice.delivered` is required, and the 48-hour quiet period after the latest one applies.
- **Duplicates:** the stage key is checked *before* the customer-day rule.
- **One reminder per customer per local day:** any `invoice.reminder` event today counts, whatever its outcome. The customer is marked before the stage runs.
- **Outcome names**, unchanged.

**The runtime runs the claimed stage:**
1. Kill switch, then soft claim.
2. B1 on the invoice's customer:
   - unknown → nothing recorded, the stage stays eligible;
   - another organization's or no contact → recorded blocked `contact_not_found`, with no conversation.
3. Claim: `invoice.reminder:<invoice_id>:<stage>` + B0.
4. **verifyClaimed**:
   - the invoice is re-read, organization-scoped;
   - missing, or no contact → blocked `invoice_not_found`;
   - no usable payment link → blocked `payment_link_unavailable` (outcome `no_payment_link`);
   - otherwise the refreshed invoice, contact and link are what compose, the conversation and the gate use.
5. The outbound gate, with the invoice check and the automation's enabled state.
6. Send (sender `system`).
7. A **minimal** record:
   - `{ should_send, blocked_reason }` or `{ should_send: true, sent: true }`, plus `{ invoice_id, stage }`;
   - a failed send records only "The invoice reminder SMS could not be sent." (category `sms_send_failed`).

**Consumed keys:** every post-claim block completes the execution and keeps the key, so a later run sees a duplicate.

**No A2 retry:** invoice reminders are in neither `SAFE_RETRY_AUTOMATION_IDS` nor `AUTOMATIC_RETRY_POLICY`. A retry is `not_safely_retryable`.

**Tests:**
- `lib/automation/invoice-reminders.runtime.test.ts`: the real gate and B1.
- `lib/automation/invoice-reminders.test.ts`: producer rules, wording, route, and the behavioural single-send-spine check.

### n8n executor foundation (P0-B B2.8a)

**HIGH-1 fix (duplicate n8n callback).**
- **The bug:** two concurrent deliveries of the same callback both pass the gate. The outbound unique index (`messages.workflow_execution_id`, outbound) admits one send. The loser's `sendOutboundMessage` reported "already has an outbound message in progress", and the callback treated that as `sms_send_failed`. That failed the execution the winner was still sending, and A2 could then retry `lead_created_followup` and send again.
- **The fix:**
  - `sendOutboundMessage` now marks that result `duplicateInProgress: true`. It is set only when the index rejects the insert and the owner's row is not yet `sent`.
  - The callback answers that case as `alreadyProcessed` and never fails the execution. The owner records the outcome, including a genuine provider failure.
  - `executeTouch` returns `{ kind: "duplicate_in_progress" }` for the same case, records nothing, and never fails.
- **Unchanged:** the database index is still the guarantee.
- **Test:** `app/api/automation/n8n-callback/duplicate-callback.test.ts`.

**The draft hand-off contract** (`lib/automation/touch-runtime.ts`). It is unused by every existing kind. It splits the same derived pipeline at the claim.

`claimAndHandOffTouch` handles the claim and hand-off:
1. Runs steps 1–8: kill switch, payment, due, soft claim, B1, still owed, stale, then the claim (key + B0 start). The execution starts with `DRAFT_HANDOFF_METADATA` (`{ handoff: "n8n_draft" }`).
2. Calls the kind's hand-off (the n8n dispatch) with identifiers only.
3. Returns one of five distinct results:
   - `handed_off`
   - `already_processed`
   - `blocked` (recorded)
   - `unavailable` (nothing recorded)
   - `failed` (`recorded` says whether the claimed execution was failed; a failed hand-off is `draft_handoff_failed: …`, category `n8n_dispatch_failed`)

`resumeClaimedTouch` handles the returned draft:
1. **Re-validation:** Trackpr re-reads the execution and its event, and checks the organization, event, workflow, automation, the subject's key and the hand-off marker.
   - Any mismatch is `rejected`, and nothing is recorded.
   - A non-running execution is `already_processed`.
2. **Draft checks:**
   - a declined draft (null body) is recorded as `blocked` `draft_declined`;
   - a needs-human draft is recorded as `blocked` `needs_human`;
   - a malformed draft fails the execution (`draft_invalid: …`).
3. **The spine:** B1 → still owed → `verifyClaimed` → gate → send → record. This is the same post-claim spine `runDerivedTouch` and `retryDerivedTouch` now share; the draft is the body and the kind's `compose` is not called. A concurrent duplicate resume is `already_processed`.

**The draft is never an authorization.** The runtime's `TouchDraft` is `{ body, needsHuman }`. The n8n wire contract (`lib/automation/n8n.ts` `validateN8nDraftCallback`) is strict and allowlist-only:
- `execution_id`, `event_id`, `organization_id`, `automation_id`;
- `draft { body, needs_human, classification, model, usage }`.

Any other field is rejected, never ignored. That includes:
- recipient or contact
- send authorization or gate result
- lifecycle, payment or automation state
- retry or timing

**Out of this phase:** the new contract carries no authentication change and no HMAC.

**Tests:** `lib/automation/touch-runtime.test.ts` 31–39 and `lib/automation/n8n-draft.test.ts`.
