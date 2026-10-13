# Trackpr release readiness (audit, 2026-10-13; updated phase 4)

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

## Release scope (phase 4 finding)

The release candidate is **not just the audit fixes**: `b6cbde3..a83fb32` is 28 commits / 242 files and includes the whole `feature/quote-redesign` line - quote redesign, Agency client handoff + delivery, the (now disabled) Founder workspace, scheduling. Schema those features need, checked read-only on 2026-10-13:

| Pending file | Production | TEST | Code without it |
|---|---|---|---|
| `job_scheduled_for.sql` | **absent** | present | **every job read fails** (selected unconditionally) - BLOCKER |
| `estimate_quote_details.sql` (`estimates.number/scope_of_work/terms`, `estimate_line_items`) | absent | present | quote reads fall back to the old quote; the quote-details **editor's writes fail** - required for the feature |
| `lead_web_form_intake_unique.sql` | absent | **absent** | works without (unmarked insert + warning); concurrent duplicates not prevented |
| `agency_client_handoff.sql`, `agency_client_delivery.sql` | absent | present | Agency handoff/delivery pages show "unavailable" (missing-schema handled) |
| `founder_*.sql` (4 files) | absent | present | Founder UI returns 404 for everyone; not needed |

## Required migrations (none applied; each needs explicit approval)

Order for Production: 1 -> 2 -> 3. Each file is one transaction (`begin; ... commit;` or a single statement), idempotent, validated locally on PGlite (`supabase/pending/scratch/validate-job-scheduled-for.mjs` 4/4, `validate-estimate-quote-details.mjs` 7/7, `validate-lead-web-form-intake-unique.mjs` 6/6, each including rollback twice). PGlite is a single session: true concurrent-insert behaviour rests on Postgres unique-index semantics, not on these runs.

Check queries below use `pg_attribute`/`::regclass` (visible to every role) rather than `information_schema` (which hides objects the role cannot access and would report "absent" for an unauthorized query). A missing table makes `::regclass` **error** - an error is "query failed", never "absent". Each starts with `current_user` so a wrong-role run is visible.

### 1. `job_scheduled_for.sql` - BLOCKER, before the deploy
- Change: `jobs.scheduled_for timestamptz` nullable, no default, no backfill, no index; comment. RLS unchanged (row policies cover new columns). Rerun-safe (`add column if not exists`).
- Lock: brief `ACCESS EXCLUSIVE` on `jobs`, catalog-only (no rewrite).
- Rollback: `job_scheduled_for_rollback.sql` drops the column - only after the code is rolled back (deployed code reads it) - loses any dates entered.
- Preflight: `select current_user, (select attname from pg_attribute where attrelid = 'public.jobs'::regclass and attname = 'scheduled_for' and not attisdropped) as col;` -> `col` null.
- Postflight: same query -> `scheduled_for`; `select format_type(atttypid, atttypmod), attnotnull from pg_attribute where attrelid = 'public.jobs'::regclass and attname = 'scheduled_for';` -> `timestamp with time zone | false`.

### 2. `estimate_quote_details.sql` - required for the quote editor
- Change: `estimates.scope_of_work`, `terms` (nullable text); `estimates.number` integer **backfilled per organization in creation order, then NOT NULL**, `check (number > 0)`, `unique (organization_id, number)`; numbering trigger (locks the organization row so concurrent inserts queue; the unique constraint is the backstop); `estimate_line_items` table with RLS (`is_org_member` + payment-active restrictive policy) and draft-only triggers. Rerun-safe (guards on every object; backfill only touches `number is null`).
- Lock/risk: the backfill UPDATE rewrites every estimate row and `SET NOT NULL` + the unique constraint scan the table under `ACCESS EXCLUSIVE` on `estimates` - brief at current size, but estimate writes block for the duration. Apply in a quiet window.
- Rollback: `estimate_quote_details_rollback.sql` drops the table, columns, triggers - **line items and quote text are lost**; quote numbers shown to customers disappear.
- Preflight: `select current_user, (select attname from pg_attribute where attrelid = 'public.estimates'::regclass and attname = 'number' and not attisdropped) as number_col, to_regclass('public.estimate_line_items') as line_items;` -> both null.
- Postflight: `number_col = 'number'`, `line_items` not null; `select count(*) from public.estimates where number is null;` -> 0; `select relrowsecurity from pg_class where oid = 'public.estimate_line_items'::regclass;` -> true.

### 3. `lead_web_form_intake_unique.sql` - recommended, order-independent
- Change: `leads.intake_channel` (nullable, check `= 'web_form'`), partial unique index `leads_one_new_web_form_intake_per_contact (organization_id, contact_id) where intake_channel = 'web_form' and status = 'new' and contact_id is not null`. Existing rows stay null -> index cannot conflict. Under concurrency the second insert waits on the first's uncommitted index entry, then gets 23505 (or succeeds if the first rolled back); the code reuses the winner.
- Lock: `CREATE INDEX` (not concurrently - inside a transaction) holds SHARE on `leads` (blocks lead writes) while building over a predicate matching no rows.
- Rollback: `lead_web_form_intake_unique_rollback.sql`; the code keeps working (fallback path).
- Preflight: `select current_user, (select attname from pg_attribute where attrelid = 'public.leads'::regclass and attname = 'intake_channel' and not attisdropped) as col, to_regclass('public.leads_one_new_web_form_intake_per_contact') as idx;` -> both null.
- Postflight: both non-null; `select indisunique from pg_index where indexrelid = 'public.leads_one_new_web_form_intake_per_contact'::regclass;` -> true.

Retry-window deferral needs no migration. Agency/Founder migrations are not required for this release.

## Release plan (dependency order)

1. Approval for migrations 1-3 (TEST and Production separately).
2. TEST: apply 3 (1 and 2 are already on TEST); confirm the Preview's database; run the integration tests with TEST credentials; one end-to-end lead and lifecycle on TEST (see "TEST lifecycle" below).
3. Production, quiet window: preflight -> 1 -> 2 -> 3 -> postflight -> ledger read-back (`select version, name from supabase_migrations.schema_migrations order by version desc limit 5;`) -> move each file into `supabase/migrations/` under its recorded version.
4. Merge and deploy (promotion is a separate approval).
5. Watch: lead capture status mix, `[lead-intake] leads.intake_channel is missing` (should not appear), job pages, quote editor saves, follow-up dispatch / A2 deferrals, Today errors.

Rollback: redeploy `b6cbde3` first (reads none of the new columns). Then leave the additive migrations in place unless they cause harm; 2's rollback destroys quote data.

## TEST lifecycle - blocked

Not run. Blockers: (a) no authorization to mutate TEST data or apply migration 3 to TEST; (b) the Preview's database cannot be confirmed (environment values are not readable); (c) a valid form token would have to be read from TEST data; (d) integration-test credentials are not in this environment. Needed: approval to use TEST, the Preview -> TEST confirmation, and TEST credentials for the integration suite.

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

## Decision notes

### Refunds and disputes (current: incident only; Collected unchanged until a person reverses)

Example: $1,000 invoice paid online, then $400 refunded, later a $600 dispute.

| Option | Collected after refund | After dispute opened | After dispute lost | Notes |
|---|---|---|---|---|
| A. Current (manual reversal) | $1,000 until someone reverses | $1,000 | $1,000 | Overstates; relies on a person noticing the incident |
| B. Auto-reverse refunds; disputes flagged, reversed only when lost (**recommended**) | $600 on the refund date | $600, payment flagged "disputed" | $0 | Matches cash actually kept; needs per-refund reversals (today's `customer_payments_reversal_unique` allows one reversal per payment - partial refunds need a refund-id key) and handling `charge.dispute.closed` |
| C. Auto-reverse refunds and disputes immediately | $600 | $0 | $0 (re-credit if won) | Understates while a dispute is open; more churn |

Idempotency for B/C: the Stripe refund id / dispute id as the reversal key. Needs a migration (reversal key) - not started.

### Capture response privacy

Responses return `leadId`, `contactId`, `duplicate`, `attachedToExistingLead`. In-repo consumers: none (the route is only linked from Settings/Onboarding as a URL to paste into a contractor's own form or tool). External consumers are unknown - contractors' forms, Zapier-style tools, or n8n may read the ids. Recommendation: keep v1 unchanged; add a v2 response (`{ ok, status: "received" }`, selected by `?v=2` or `Accept: application/vnd.trackpr.v2+json`); make the Settings/Onboarding snippet use v2; log v1 usage per organization; remove ids from v1 only after usage reaches zero, with notice.

### 409 contact conflicts

| | Keep 409 (current, generic message) | Accept (202) and queue for review |
|---|---|---|
| Privacy | status still reveals "something conflicts" (rate-limited: 5/phone/hour) | reveals nothing |
| Data | the submission is **lost** unless the submitter calls | kept; a person reconciles the two contacts and the lead is created |
| Work | none | needs a review queue (table or `audit_log` + Today item) and a reconcile action |

Recommendation: accept-and-queue - losing a real customer's request is the bigger cost; needs product approval and a small migration or audit-log design.

### Failed follow-up recovery - verified

Stop / Skip-this-message: org admin/owner only (`assertOrgAdmin` in the server action; non-admins see the list without controls); conditional on `state = 'failed'` (a second click returns "no longer waiting for review" and changes nothing); `audit_log` row `followup_failed_resolved` with the acting user, resolution and skipped touch; organization-scoped reads and writes; listed on the Lead Follow-Up Sequence page that Today's "needs review" item links to. Never re-sends the failed touch. Covered by `lib/followups/followups.test.ts` (recovery + recovery UI).

## Not verified

- Vercel runtime logs for `/api/leads/capture`: the log API returned **403 Forbidden** for the team scope - unknown, not "no errors".
- A real valid-token lead submission end to end.
- Integration tests (100 files): need Supabase URL + keys, not present in the audit environment.
- Production build (`next build`) - see the audit report for whether it ran.

## Roadmap

`Trackpr_Master_Product_Roadmap_No_Gaps.pdf` was not found in the repository or the audit environment's filesystem; no roadmap comparison was made.
