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
| `5941ad4` | new | Review fix to `55b5b78`: Stop/Skip are offered and accepted only once Trackpr has stopped retrying a failed follow-up (no attempt running, undecided or scheduled); before, a person could "skip" a message an in-flight automatic retry then sent. Today counts still-retrying follow-ups as Trackpr's work, not "needs review" |

Offline validation at `5941ad4` (2026-10-13): `tsc --noEmit` exit 0; ESLint on all 136 changed files exit 0, no warnings; `next build` exit 0; unit suite 2,758 tests, 2,751 pass, 7 fail - exactly the 7 database-backed files below, each failing only on missing Supabase configuration. The new resolve guard was mutation-checked (removing it fails a test).

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

Preview database identity (2026-10-13, read-only, no secrets read): the Preview for this branch (`contractor-growth-co-v4-16pq64xiz-contractor-growth-co.vercel.app`, commit `3e3ec7a`; later commits change only tests and these notes) answers `/api/health` with `database: ok` and `lastHeartbeatAt: null`. TEST's `automation_health_check_runs` is empty; Production's gets a row every 15 minutes; the only other Supabase project (`trackpr-v2`) is paused. So the Preview reads TEST, not Production. The disposable TEST org ("Smoke Test Disposable Org", `automation_mode = test`, no SMS number) has an intake token that does not exist in Production (checked read-only), so a submission with it cannot create a Production row. The synthetic-lead POST itself was not sent: this session's permission policy blocked it pending the owner's explicit go-ahead.

Re-check at `041606a` (2026-10-13): still no `.env.local` and none of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TRACKPR_INTEGRATION_TARGET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` set (Twilio/Resend also absent, as required). Each of the 7 database-backed files was run on its own: every one fails only on missing configuration (`supabaseUrl is required` or `Supabase service-role client is not configured`); the rest of their tests pass (passed/total: forgot-password 6/7, signup 6/7, agency organizations 12/13, Stripe webhook 0/1 - the file fails while loading, reset-password 6/7, blocked-time 6/7, opportunities 10/11). Per-file needs: all 7 need the TEST Supabase URL + anon + service-role keys; `app/api/webhooks/stripe/route.test.ts` also needs `STRIPE_SECRET_KEY` (test mode) and `STRIPE_WEBHOOK_SECRET`; `app/(auth)/signup/actions.notification.test.ts` also reads `RESEND_API_KEY`/`EMAIL_FROM` (Resend calls stay blocked by the guard). The 102 integration files were not started. Classification: no product defect in any of the 7 - the failing piece in each is the block that builds a real Supabase client at module load. That loud failure without credentials is the repository-wide convention (the integration files do the same) and is kept deliberately: turning it into a silent skip would let an un-run database suite look green. The synthetic lead was not submitted (its precondition - TEST credentials configured - is not met).

Re-check at `10b959e` (2026-10-13):
- CI: the repository has no GitHub Actions workflows (no runs for this branch). The Vercel Preview build for `10b959e` (`dpl_D736Uj8RH72txZr9tXxBXHGJJ2Mp`, `contractor-growth-co-v4-jffm61o1e-contractor-growth-co.vercel.app`) is READY; it answers `/api/health` with `database: ok`, `lastHeartbeatAt: null` - TEST still has 0 heartbeat rows, Production's latest is 18:21 UTC - so this Preview also reads TEST.
- Offline: `tsc` exit 0; ESLint on the 136 changed files exit 0, 0 warnings; `next build` exit 0; unit suite 2,758 tests - 2,751 pass, 7 fail (the same 7 credential-only files), 0 skipped, 0 cancelled. `lib/followups/followups.test.ts` 44/44, including the three `5941ad4` regression tests.
- Credentials: still none of the six variables above, no `.env.local`. The environment has a `STAGING_SUPABASE_URL` pointing at a different project (`puupyjfohltgynvhoghh`, not TEST and not in this Supabase account's project list) and no key for it; it was not used - the guard would refuse it.
- Integration suite (102 files) and the 7 database-backed files: not run. Synthetic lead: not sent (precondition not met; it also needs the owner's explicit approval).

Minimum safe action to unblock (by a person with TEST access):
1. On a machine with the repo at this branch, create `.env.local` with TEST's URL, anon key and service-role key (legacy JWT keys), Stripe **test-mode** keys, no Twilio/Resend credentials, and `TRACKPR_INTEGRATION_TARGET=test`.
2. Run `node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test $(git ls-files '*integration.test.ts')` and the 7 database-backed unit files; the guard refuses anything not provably TEST.
3. Lifecycle check on TEST: submit one synthetic lead to `/api/leads/capture/<TEST org token>` on a deployment known to use TEST; verify contact/lead/`lead.created`/follow-up rows by id. Optionally apply `lead_web_form_intake_unique.sql` to TEST first (separate authorization) to exercise the concurrency path.

### Roadmap availability

The Trackpr Master Product Roadmap is not in this repository (only `docs/trackpr-hermes-separation-plan.md` refers to it, and says it is stored elsewhere) and not on this machine. Google Drive search and recent-files listing both return `Forbidden` (2026-10-13, re-checked at `10b959e`); no file whose name contains "roadmap" exists on any branch or tag of this repository, and GitHub code search finds none, so the release scope could not be checked against the roadmap. **Roadmap compliance: unverified.** No roadmap gaps are claimed or verified here; this release was reviewed against its own documented requirements (the table above and the audit findings it fixes).

## Release checklist (for a human reviewer)

Technical blockers (must be done before Production):
1. Code review of `b6cbde3..` this branch (20 non-test files incl. the guard and the optional SQL; the guard change touches 109 test files with one added import each). A self-review at `5941ad4` covered the capture route, intake, follow-up producer/engine/recovery, A2 retry deferral, Today visibility, payments ledger, payment date rule and jobs filter; it found and fixed one defect (`5941ad4`) and nothing else.
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
