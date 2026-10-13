# Trackpr release readiness (audit, 2026-10-13)

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

## Release blocker: `jobs.scheduled_for`

Production runs `b6cbde3`, which does not use the column. `feature/quote-redesign` (and this branch) select it in `lib/jobs/queries.ts` for every job read, and write it from the job page. **Deploying this branch to Production before `supabase/pending/job_scheduled_for.sql` is applied breaks every job read.**

Migration plan (requires explicit approval; not applied):
1. File: `supabase/pending/job_scheduled_for.sql` - one nullable `timestamptz` column, no default, no backfill, RLS unchanged, idempotent. Rollback: `job_scheduled_for_rollback.sql` (contains DROP; run by a person).
2. Lock: `ALTER TABLE ... ADD COLUMN` (nullable, no default) takes a brief `ACCESS EXCLUSIVE` lock on `jobs` and rewrites nothing. No uniqueness, no data conflicts possible.
3. Process: per `supabase/pending/README.md` - a person applies it to one named project as one transaction, reads back the ledger, then moves the file into `supabase/migrations/` under the recorded version. Never `supabase db push`.
4. Verify after: `select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='scheduled_for';` → one row, `timestamp with time zone`, `YES`.
5. Order: migration first, then deploy.

## Fixes on this branch (each with a regression test that failed before)

| Area | Fix | Test |
|---|---|---|
| Lead capture | Duplicate-window read error fails closed (503) | `lib/leads/intake.test.ts` web form 5 |
| Lead capture | A `lead.created` event lost on first submission is re-emitted on retry (idempotent key; only for a still-`new` lead this route created) | web form 6 |
| Lead capture | 409 conflict no longer tells the submitter a phone and email belong to different existing contacts; details logged server-side | conflict (audit) |
| Payments | Server refuses a future received date | `lib/invoices/service.test.ts` |
| Money | Payments ledger paged in full; a partial read reports `failed` (was a silent 5,000-row cap) | `lib/invoices/payments-ledger.test.ts` |
| Follow-ups | Rows stranded in `pending` are scheduled by the next dispatch tick (after a lease-length grace) | `lib/followups/followups.test.ts` recovery |
| Today | Failed follow-ups shown as needing attention, not as active; count errors logged | followups Today (audit) |
| Today | "In progress" tile links to `status=active` (scheduled + in progress), matching the number it shows | `lib/jobs/queries.test.ts`, `dashboard.test.ts` |

## Confirmed, not fixed (decision or larger change needed)

1. **Concurrent web-form submissions can create two open leads.** The duplicate check is read-then-insert. A unique index cannot single out web-form leads because the route stores the submitter-supplied `source`. Options: (a) store a fixed origin marker (e.g. `intake_channel = 'web_form'`) and add a partial unique index like the SMS one; (b) a transaction-scoped advisory lock per (organization, contact) via an RPC. Both need a migration.
2. **Follow-up retry outside the send window consumes the touch.** `retryObligationTouch` goes straight to the gate; a quiet-hours or business-hours denial is non-terminal and advances the cadence. A2 retries at 5/15/45 minutes (3 attempts), so a night-time failure exhausts before morning. Fix needs A2 to accept a "defer until" time (`next_retry_at`) instead of failing.
3. **`start_failed` follow-ups go to human review** (`state = failed`, `next_action = human_review`) by design; they are now visible on Today. There is no UI action to resume one.
4. **Capture responses still return internal `leadId`/`contactId` and `duplicate`/`attachedToExistingLead` flags.** External forms may read these, so removing them is a contract change for contractors' integrations.
5. **Accepted estimate → job with status `scheduled`.** Intended semantics (see `job_scheduled_for.sql`): `status = scheduled` means "not started"; booking is `scheduled_for`. Resolved by the migration above plus the existing job-page scheduling UI; not by changing status semantics.
6. **Manual-payment duplicate key is optional server-side** on purpose (older open dialogs). All current callers (`record-payment-dialog.tsx` → `recordCustomerPayment` → service) send one.

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
