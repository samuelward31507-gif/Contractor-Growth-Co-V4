# Trackpr release readiness (audit, 2026-10-13; updated phase 3)

Branch `audit/trackpr-readiness-fixes`. Not merged, not deployed.

## Production schema (verified read-only, project `mywznmxtlgajnczjvbmk`, 2026-10-13)

Catalog-only queries (`information_schema`, `pg_catalog`, `supabase_migrations.schema_migrations`); no table data read, nothing written.

| Object | Production | Ledger |
|---|---|---|
| `leads.sms_consent` + `leads_sms_consent_check` | present | `20261007132058 lead_sms_consent` |
| `followups` table (16 columns, identical to `supabase/pending/followups.sql`), `followups_lead_stage_unique`, RLS on, policies `followups_select`, `followups_payment_active` | present | `20261007131929 followups` |
| `start_workflow_execution(uuid,text,jsonb,text)` atomic claim | present | `20261007132026 start_workflow_execution_atomic_claim` |
| `leads_one_new_sms_intake_per_contact` | present | `20261007131814 lead_sms_intake_unique` |
| `dashboard_summary(uuid,timestamptz,timestamptz,timestamptz)` | present | `20260929074741 dashboard_sql` (+ attention, conversation follow-ups) |
| `customer_payments` Stripe columns, `customer_payments_stripe_checkout_session_unique`, `customer_payments_stripe_payment_intent_unique`, `customer_payments_org_client_key_unique`, `customer_payments_reversal_unique`, `customer_payments_online_guard` | present | (applied; no ledger name match for `online_payments`) |
| `invoices_one_live_per_job` | present | - |
| **`jobs.scheduled_for`** | **absent** | - |

Ledger: 68 rows; latest `20261007132058`. `supabase/pending/README.md` still describes several of these as "not applied to Production" - that text is out of date (the README is protected and was not edited here).

## Required migrations (none applied; each needs explicit approval)

### 1. `job_scheduled_for.sql` - BLOCKER, must precede the deploy

This branch selects `jobs.scheduled_for` on every job read (`lib/jobs/queries.ts` JOB columns) and also uses it in `app/(app)/jobs/actions.ts`, `app/(app)/jobs/[id]/page.tsx`, `app/(app)/jobs/[id]/_components/job-schedule-section.tsx`, `lib/dashboard/queries.ts`, `lib/jobs/schedule.ts`, `lib/people/next-step.ts`. Production lacks the column (verified). Deploying first breaks every job read.

- Shape: one `timestamptz`, nullable, no default, no backfill, no index; RLS unchanged (row policies already cover it); idempotent (`add column if not exists`). Rollback `job_scheduled_for_rollback.sql` (DROP; run by a person; only safe after rolling the code back first).
- Lock: brief `ACCESS EXCLUSIVE` on `jobs` for a catalog-only change (nullable, no default: no table rewrite).
- Preflight (read-only):
  `select count(*) = 0 as column_absent from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='scheduled_for';` -> `true`
  `select version, name from supabase_migrations.schema_migrations order by version desc limit 1;` -> record it.
- Postflight:
  `select data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='scheduled_for';` -> `timestamp with time zone | YES | null`
  plus the ledger read-back, then move the file into `supabase/migrations/` under the recorded version.

### 2. `lead_web_form_intake_unique.sql` - recommended, order-independent

Adds `leads.intake_channel` (nullable, check `= 'web_form'`) and partial unique index `leads_one_new_web_form_intake_per_contact`. All existing rows are null, so it cannot conflict with data; `CREATE INDEX` holds a SHARE lock on `leads` while building over a predicate that matches no rows. The code works before it (falls back to an unmarked insert and logs a warning) and after it (duplicates prevented). Validated: `supabase/pending/scratch/validate-lead-web-form-intake-unique.mjs`.
- Preflight: `select count(*) = 0 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='intake_channel';`
- Postflight: `select indexdef from pg_indexes where indexname = 'leads_one_new_web_form_intake_per_contact';` -> one row.

Retry-window deferral needs **no** migration (uses existing `next_retry_at`).

## Release plan (dependency order)

1. Approval for the migrations above.
2. TEST: apply `job_scheduled_for.sql` and `lead_web_form_intake_unique.sql`; read back; deploy the branch as a Preview against TEST; run the integration tests with TEST credentials; one end-to-end lead on TEST.
3. Production: preflight queries; apply `job_scheduled_for.sql` (and the intake migration); postflight; ledger read-back.
4. Merge and deploy the code (promotion is a separate approval).
5. Watch: lead capture 201/200/409/503 rates, `[lead-intake] leads.intake_channel is missing` warnings (should be none), follow-up dispatch and A2 retry outcomes, Today load errors.

Rollback: redeploy `b6cbde3` first (it does not read either new column), then - only if needed - the rollback SQL files. Additive columns can stay after a code rollback.

## Fixes on this branch (each with a regression test that fails without it)

| Area | Fix | Test |
|---|---|---|
| Lead capture | Duplicate-window read error fails closed (503) | `lib/leads/intake.test.ts` web form 5 |
| Lead capture | Lost `lead.created` re-emitted on retry (idempotent key; still-`new` leads this route created) | web form 6 |
| Lead capture | 409 conflict no longer discloses that a phone and email belong to two contacts | conflict (audit) |
| Lead capture | Simultaneous submissions -> one lead, one `lead.created` (route-set `intake_channel` + pending unique index; pre-migration fallback) | web form 7, 8; PGlite validator |
| Payments | Server refuses a future received date | `lib/invoices/service.test.ts` |
| Money | Payments ledger paged in full; partial read reports `failed` | `lib/invoices/payments-ledger.test.ts` |
| Follow-ups | Rows stranded in `pending` are scheduled by the next tick | `lib/followups/followups.test.ts` recovery |
| Follow-ups | A2 retry of a follow-up touch falling due outside quiet/business hours is moved to the next allowed moment (no attempt consumed, nothing sent); no allowed time in 8 days -> not_retryable | `lib/automation/execution-retry.test.ts` (UTC night, NY, weekend, DST, closed) |
| Follow-ups | Failed follow-ups: admin can Stop or Skip-and-continue (never re-sends; idempotent; audited) on the Lead Follow-Up Sequence page | followups recovery + recovery UI |
| Today | Failed follow-ups shown as needing attention; count errors logged | followups Today (audit) |
| Today | "In progress" tile -> `status=active` (scheduled + in progress) | `lib/jobs/queries.test.ts` |
| Jobs | Undated `scheduled` job labelled "Not scheduled yet" | `lib/jobs/schedule.test.ts` |

## Remaining items (decision or access needed)

1. **Refund / dispute accounting** - see below; product decision.
2. **Public response contract** - capture responses return `leadId`, `contactId`, `duplicate`, `attachedToExistingLead`. No consumer exists in this repo, but contractors' own forms/integrations may read them, so they were not removed. Proposed path: document the contract in the settings page where the URL is shown; add `?v=2` (or an `Accept-Version` header) returning only `{ ok, status: "received" }`; switch the onboarding snippet to v2; deprecate v1 later.
3. **Capture endpoint still reveals *something* on conflict** - the 409 status (generic message). Fully hiding it means accepting the submission and queueing it for reconciliation - a product decision.
4. **Manual-payment duplicate key optional server-side** - kept on purpose for older open dialogs; all current callers send it.
5. **Seven environment-dependent unit-suite files** need a real database (with placeholder settings they still fail on connection): `app/(auth)/forgot-password/actions.test.ts`, `app/(auth)/signup/actions.notification.test.ts`, `app/agency/organizations/actions.test.ts`, `app/api/webhooks/stripe/route.test.ts`, `app/auth/reset-password/actions.test.ts`, `supabase/migrations/blocked-time-migration.test.ts`, `supabase/migrations/opportunities-migration.test.ts`. Treat as integration tests (run with TEST credentials).

## Refunds and disputes - recommended policy (product decision required)

Today a Stripe `charge.refunded` / `charge.dispute.created` on a customer payment raises an `online_payment_reconciliation` incident; Collected keeps the payment until a member records a reversal.

Recommendation:
- **Full or partial refund (Stripe-confirmed):** record a reversal row automatically for the refunded amount, linked to the original payment (the `customer_payments_reversal_unique` constraint already limits one reversal per payment - partial refunds would need that relaxed or a per-refund key). Collected drops on the refund date; the invoice balance reopens.
- **Dispute opened:** do not reverse; flag the payment "disputed" and exclude it from Collected only if the dispute is lost (`charge.dispute.closed` with `status = lost`).
- Idempotency key: the Stripe refund / dispute id.

Until decided, the current behavior (incident + manual reversal) stands and Collected can be overstated by refunded amounts.

## Not verified

- Vercel runtime logs for `/api/leads/capture`: the log API returned **403 Forbidden** for the team scope - unknown, not "no errors".
- A real valid-token lead submission end to end.
- Integration tests (100 files): need Supabase URL + keys, not present in the audit environment.
- Production build (`next build`) - see the audit report for whether it ran.

## Roadmap

`Trackpr_Master_Product_Roadmap_No_Gaps.pdf` was not found in the repository or the audit environment's filesystem; no roadmap comparison was made.
