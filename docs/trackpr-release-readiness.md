# Trackpr minimal audit release - release notes

Branch `release/audit-minimal-candidate`, based on Production `b6cbde3`. Not merged, not deployed.

**Status: production release BLOCKED pending authorized TEST validation.** No integration test and no TEST lifecycle step has been run (no TEST credentials in the review environment). Phase 8 review started from `d4dceb3`; the review commit that updates these notes follows it.
This file describes **this minimal release only**. The full candidate (`audit/trackpr-readiness-fixes`) keeps its own readiness notes, including the `jobs.scheduled_for` and quote-schema blockers that do **not** apply here.

## Contents

`b6cbde3` + four audit commits cherry-picked with `-x` (no conflicts), + the integration-test safety guard:

| Commit | Source | Fix |
|---|---|---|
| `01ef8ff` | `9ba8a6c` | Lead capture fails closed (503) when the duplicate check cannot be read; server refuses future-dated manual payments; failed follow-ups shown on Today as needing attention (count errors logged) |
| `f27d3b5` | `2988441` | A `lead.created` lost on the first submission is re-emitted on retry; the 409 contact conflict no longer reveals that a phone and email belong to two contacts; follow-ups stranded in `pending` are scheduled; Money pages the whole payments ledger (no silent 5,000 cap); Today "In progress" links to scheduled + in-progress jobs |
| `77430b6` | `3ff1e96` | A2 follow-up retries wait for the next allowed send time (quiet hours / business hours) instead of consuming attempts overnight; route-set `intake_channel = 'web_form'` + optional migration below |
| `55b5b78` | `2a5b17d` | Failed follow-ups: admins can Stop, or Skip the failed message and continue (never re-sends; idempotent; audited) |
| `3e3ec7a`, `d4dceb3` | new | Fail-closed integration-test database guard (loader + first import in database-capable tests) |

Not included (each needs schema Production lacks, or is unrelated): job scheduling and the "Not scheduled yet" label (`jobs.scheduled_for`), quote redesign (`estimate_quote_details.sql`), Agency handoff/delivery, Founder workspace, invoice-delivery fixes.

No `package.json` change. No reference to `jobs.scheduled_for`, quote-detail columns, Agency or Founder schema.

Regression tests: `lib/leads/intake.test.ts`, `lib/invoices/service.test.ts`, `lib/invoices/payments-ledger.test.ts`, `lib/followups/followups.test.ts`, `lib/automation/execution-retry.test.ts`, `lib/jobs/queries.test.ts`, `app/(app)/today/dashboard.test.ts`, `lib/automation/test-db-guard.test.ts`.

## Optional migration: `supabase/pending/lead_web_form_intake_unique.sql`

Not required to ship this release.
- Adds `leads.intake_channel` (nullable, check `= 'web_form'`) and partial unique index `leads_one_new_web_form_intake_per_contact (organization_id, contact_id) where intake_channel = 'web_form' and status = 'new' and contact_id is not null`. Existing rows stay null - no conflicts possible.
- Without it: the route's insert fails with "column does not exist", the code retries without the marker and logs `[lead-intake] leads.intake_channel is missing ...` - behavior identical to today; simultaneous duplicate submissions are still possible.
- With it: of two simultaneous inserts, the second waits for the first's uncommitted index entry, then gets 23505 and `resolveLeadForIntake` reuses the winner (one lead, one `lead.created`). If the first rolls back, the second succeeds.
- Lock: `CREATE INDEX` inside the transaction holds SHARE on `leads` (lead writes wait) while building over a predicate matching no rows - brief. Rerun-safe. Rollback (`..._rollback.sql`) is harmless: the code falls back.
- Preflight: `select current_user, (select attname from pg_attribute where attrelid = 'public.leads'::regclass and attname = 'intake_channel' and not attisdropped) as col, to_regclass('public.leads_one_new_web_form_intake_per_contact') as idx;` -> both null. Postflight -> both non-null and `select indisunique from pg_index where indexrelid = 'public.leads_one_new_web_form_intake_per_contact'::regclass;` -> true. A missing table/permission problem makes these queries error rather than report "absent".
- Validated locally: `supabase/pending/scratch/validate-lead-web-form-intake-unique.mjs`.

## Integration tests - safe procedure

`lib/automation/test-loader.mjs` (the `--import` every test run uses) installs `lib/automation/test-db-guard.mjs` before any test module loads. Every database request goes through `fetch` and is refused before it leaves the process unless:
- `TRACKPR_INTEGRATION_TARGET=test`, the host is `lwofqffxagxiqodqvcfr.supabase.co`, and the request's key is a Supabase JWT whose `ref` claim is `lwofqffxagxiqodqvcfr` (verified from the credential itself); or
- `TRACKPR_INTEGRATION_TARGET=local` and the host is loopback (a disposable local database).
Production (`mywznmxtlgajnczjvbmk`) is always refused, by host or key. Twilio, Resend and live-mode Stripe keys are always refused. Errors name the reason and project ref only.

To run them (only with authorization to write test rows to TEST):
1. `.env.local` with the TEST project's URL, anon key and service-role key (legacy JWT keys - non-JWT `sb_secret_` keys cannot be verified and are refused), Stripe test-mode keys, no Twilio credentials; set `TRACKPR_INTEGRATION_TARGET=test`.
2. `node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test $(git ls-files '*integration.test.ts')`, plus the 7 database-backed unit files: `app/(auth)/forgot-password/actions.test.ts`, `app/(auth)/signup/actions.notification.test.ts` (also needs `RESEND_API_KEY`/`EMAIL_FROM` - Resend calls are blocked by the guard), `app/agency/organizations/actions.test.ts`, `app/api/webhooks/stripe/route.test.ts`, `app/auth/reset-password/actions.test.ts`, `supabase/migrations/blocked-time-migration.test.ts`, `supabase/migrations/opportunities-migration.test.ts`.

### Guard coverage (phase 7)

- Installed by the shared loader before any test module loads, and self-installed by `import "@/lib/automation/test-db-guard.mjs"` - the first import of the 109 test files that need a real database (102 `*.integration.test.ts` + the 7 database-backed unit files). Eight further unit files read `.env.local` only for Stripe mode and use in-memory fakes (`app/api/webhooks/stripe*/**/route.guard.test.ts` x3, `lib/billing/stripe-mode-guard.test.ts`, `lib/payments/{connect-webhook,connect,pay-routes,connect-routes}.test.ts`); they are guarded by the loader and also fail to load without it (verified). Without the loader that `@/` import cannot resolve, so a direct `node --test <file>` fails to load instead of running unguarded.
- Child processes started with the loader are guarded (tested). Request shapes covered by tests: string/URL/`Request` input, plain-object/`Headers`/array headers, mixed-case hosts, `.supabase.in`.

### TEST validation status - BLOCKED

Not run. This environment has no `.env.local` and no Supabase keys; the TEST service-role key is required by the integration helpers and is not obtainable here without exposing a secret. TEST schema (read-only, 2026-10-13): has every object this release reads; lacks only `leads.intake_channel` (the optional migration) - the code falls back without it.

Minimum safe action to unblock (by a person with TEST access):
1. On a machine with the repo at this branch, create `.env.local` with TEST's URL, anon key and service-role key (legacy JWT keys), Stripe **test-mode** keys, no Twilio/Resend credentials, and `TRACKPR_INTEGRATION_TARGET=test`.
2. Run `node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test $(git ls-files '*integration.test.ts')` and the 7 database-backed unit files; the guard refuses anything not provably TEST.
3. Lifecycle check on TEST: submit one synthetic lead to `/api/leads/capture/<TEST org token>` on a deployment known to use TEST; verify contact/lead/`lead.created`/follow-up rows by id. Optionally apply `lead_web_form_intake_unique.sql` to TEST first (separate authorization) to exercise the concurrency path.

## Release checklist (for a human reviewer)

Technical blockers (must be done before Production):
1. Code review of `b6cbde3..` this branch (30+ files of product code; the guard change touches 109 test files with one added import each).
2. TEST integration run and one synthetic lead on TEST (steps above), by a person with TEST access. Record test-record ids only.
3. Decide whether to apply the optional `lead_web_form_intake_unique.sql` (TEST first, then Production); not required for this release.
4. Merge/deploy only with explicit approval; rollback = redeploy `b6cbde3` (no required schema change).

No migration is required for this release.

Guard limitations: it only protects test runs (it is not runtime code); TEST keys must be legacy JWT keys (new `sb_secret_` keys are refused as unverifiable); the TEST project ref is a constant in `test-db-guard.mjs`; it cannot stop a person running app code outside the test runner against Production.

## Product decisions (not release blockers) and known limitations

- Refunds/disputes still count as Collected until a person records a reversal (policy decision pending).
- Capture responses still include `leadId`/`contactId` (versioned-response decision pending).
- A contact conflict still returns 409 and the submission is not saved (accept-and-queue decision pending).
- Follow-ups that fail to start go to human review by design (now resolvable with Stop / Skip).
- Not verified: integration suite, a valid-token lead end to end on TEST, which database the Preview uses, Vercel runtime logs (403).
