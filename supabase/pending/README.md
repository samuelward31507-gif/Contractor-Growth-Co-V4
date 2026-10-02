# Pending migrations

Migrations that have been written and validated but **not yet applied to production**. Nothing in this folder is picked up by any tooling; the Supabase CLI only reads `supabase/migrations/`.

Why this folder exists: the production migration ledger (`supabase_migrations.schema_migrations`) does not match the filenames in `supabase/migrations/` (see the Phase 1B audit, section E), so `supabase db push` is unsafe for this project. A migration is applied deliberately by a person, the ledger entry it produced is read back, and only then is the file moved into `supabase/migrations/` under that recorded version. Phase 1A (`20260928052521_estimate_approval_links.sql`) set this precedent.

## invoice_foundation.sql (moved to supabase/migrations/20260928162500_invoice_foundation.sql)

Phase 1B foundation: `public.invoices`, `public.customer_payments`, their triggers, RLS and payment-active policies, the `create_invoice_audit_event` RPC, and a re-created `merge_contacts` that also reassigns the two new tables. Companion files:

- `invoice_foundation_rollback.sql` drops everything the forward script created and restores `merge_contacts` byte-for-byte to the captured production body. It refuses to run if any customer payment exists.
- `reference/merge_contacts.production.sql` is the exact production body (md5 `16eb8b6540778969e6d489953494c44b`, 6867 bytes) captured read-only on 2026-09-28 before any change.
- `scratch/validate.mjs` applies the forward script to an in-memory Postgres 17 (PGlite), applies it a second time to prove idempotency, exercises every rule, runs the rollback, and applies once more. Run with `cd supabase/pending/scratch && npm install && npm run validate`. It never connects to a real database.

### Apply procedure (a person does this, not tooling)

1. Re-run the read-only capture query in `reference/merge_contacts.production.sql` and confirm the md5 is still `16eb8b6540778969e6d489953494c44b`. If it differs, stop: production's `merge_contacts` changed and section 6 of the forward script must be rebased on the new body.
2. Confirm no table named `invoices` or `customer_payments` exists in production (`select to_regclass('public.invoices'), to_regclass('public.customer_payments')` should both be null).
3. Apply `invoice_foundation.sql` as a single transaction (Supabase SQL editor or the MCP `apply_migration` tool with the name `invoice_foundation`). The script wraps itself in `begin; … commit;`.
4. Read back the ledger entry: `select version, name from supabase_migrations.schema_migrations order by version desc limit 1`.
5. Verify read-only: both tables, 6 triggers, 6 functions plus the RPC, 7 policies, and that `md5(pg_get_functiondef('public.merge_contacts'::regproc))` differs from the captured value (the new body) while still containing the `-- invoices` block.
6. Move the file: `git mv supabase/pending/invoice_foundation.sql supabase/migrations/<recorded version>_invoice_foundation.sql`, commit, and leave the rollback and reference files in place.

### Status

Applied to production on 2026-09-28 via the MCP `apply_migration` mechanism (without the file's explicit `begin;`/`commit;` wrapper, which the mechanism supplies). Recorded as ledger version `20260928162500 invoice_foundation`. The file now lives at `supabase/migrations/20260928162500_invoice_foundation.sql`; only the rollback, reference and scratch files remain here.

## invoice_foundation_grants.sql (moved to supabase/migrations/20260928163516_invoice_foundation_grants.sql)

Standalone follow-up that narrows table privileges on the two new tables. invoice_foundation's GRANTs were additive on top of the project's default privileges (`pg_default_acl` grants every table privilege to anon, authenticated and service_role on each new table), so production ended up with ALL for all three roles. This script revokes exactly four things: ALL from anon on both tables, DELETE from authenticated on invoices, and UPDATE/DELETE from authenticated on customer_payments. service_role, RLS, triggers and functions are untouched. `invoice_foundation_grants_rollback.sql` re-grants those four. `scratch/validate-grants.mjs` proves both against a reproduction of the production starting state.

### Status

Applied to production on 2026-09-28 via the MCP `apply_migration` mechanism. Recorded as ledger version `20260928163516 invoice_foundation_grants`. Verified afterwards: anon holds no privileges on either table; authenticated holds SELECT, INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER on invoices and SELECT, INSERT, TRUNCATE, REFERENCES, TRIGGER on customer_payments; service_role still holds ALL. The file now lives at `supabase/migrations/20260928163516_invoice_foundation_grants.sql`.

### If it must be undone

Before any invoice exists, run `invoice_foundation_rollback.sql` as one transaction, then decide separately whether to delete the ledger row. After invoices exist, do not roll back; hide the UI instead.

## payment_idempotency_and_invoice_opportunities.sql (moved to supabase/migrations/20260928181837_payment_idempotency_and_invoice_opportunities.sql)

Phase 1B-5 (Lifecycle Signals). Two additive changes in one script:

1. `public.customer_payments.client_key` (nullable text, 8-128 URL-safe characters via `customer_payments_client_key_shape`) with the partial unique index `customer_payments_org_client_key_unique (organization_id, client_key) where client_key is not null`. The Record-payment dialog mints one key per submission and reuses it on retries; `lib/invoices/service.ts` resolves a replay to the row the first attempt created. The append-only trigger function `customer_payments_immutable` is re-created with `client_key` added to its list of columns an UPDATE may never change - the harness proved that without this line the key was editable after the fact. It is the only function the script replaces; no policy, trigger definition or grant changes.
2. `opportunities_type_check` widened with `completed_job_not_invoiced` and `invoice_overdue` (both sourced from `job`; the invoice id travels in `metadata.invoice_id`).

Companion files (kept here):

- `payment_idempotency_and_invoice_opportunities_rollback.sql` refuses to run while any keyed payment or new-type opportunity exists, then restores `customer_payments_immutable` byte-for-byte, drops the index, constraint and column, and re-creates the 12-type CHECK.
- `scratch/validate-payment-idempotency.mjs` reproduces the pre-migration production state (foundation + grants), applies the script twice, exercises key uniqueness per organization, key shape, append-only, RLS, grants, payment gate, the new opportunity types, dedup and the rollback. Run with `cd supabase/pending/scratch && npm run validate:idempotency`. It now reads the script from its `supabase/migrations/` location.

### Status

Applied to production on 2026-09-28 via the MCP `apply_migration` mechanism with the name `payment_idempotency_and_invoice_opportunities`, applied once, as the file's exact text (md5 `8c97dac247e7dd91ca074fc78a4285c4`, identical to commit `9bc2bbb`). Recorded as ledger version `20260928181837` (ledger count 51 -> 52). The file now lives at `supabase/migrations/20260928181837_payment_idempotency_and_invoice_opportunities.sql`, unmodified; its header comment still reads "STATUS: PENDING" because the SQL text is deliberately kept byte-identical to what was applied.

Verified read-only afterwards: the column (text, nullable, no default), the unique index, the validated shape constraint, `customer_payments_immutable` containing the `client_key` comparison (still SECURITY DEFINER, `search_path=public`), the 14-type CHECK validated against all existing opportunity rows. Unchanged: every other invoice/payment function including `merge_contacts`, all 8 triggers on invoices/customer_payments/opportunities, all 125 public policies, all grants (authenticated still SELECT/INSERT only on customer_payments, anon nothing), and every other public function, index and constraint (fingerprints identical before and after). No invoice or payment rows were created.

### If it must be undone

Run `payment_idempotency_and_invoice_opportunities_rollback.sql` as one transaction, by a person. It refuses while any keyed payment or new-type opportunity exists; after real payments carry keys, do not roll back.

## online_payments.sql (PENDING - not applied anywhere)

Phase 1C (Online Payments): a contractor's customer pays an issued invoice by card through Stripe Checkout, as a direct charge on the contractor's own Standard-style connected Stripe account, with no platform fee. Four additive sections:

1. `organizations`: `stripe_connect_account_id` (shape-checked, partial unique), `stripe_connect_charges_enabled`, `stripe_connect_payouts_enabled`, `stripe_connect_details_submitted`, `stripe_connect_synced_at`. The guard trigger `organizations_stripe_connect_guard` (BEFORE INSERT OR UPDATE) lets only the service role set or change them.
2. `invoices.payment_token`: the public token behind `app/pay/[token]`, using `estimates.approval_token`'s model (48 hex characters from `extensions.gen_random_bytes`, unique). It's backfilled by the column default during the table rewrite, so no row trigger fires and `updated_at` is untouched. `invoices_payment_token_guard` regenerates the token on every INSERT and lets only the service role change it afterwards.
3. `customer_payments`:
   - `card_online` added to `customer_payments_method_check`
   - `stripe_checkout_session_id`, `stripe_payment_intent_id`, `stripe_account_id`
   - `customer_payments_stripe_fields`: an ordinary `card_online` row carries all three ids, every other row carries none; a NULL id never passes
   - global partial unique indexes on the session id and the payment intent id, so a replayed `checkout.session.completed` can't add a second row
   - `customer_payments_online_guard` (BEFORE INSERT): an ordinary `card_online` row may only come from the service role, and its `stripe_account_id` must equal the organization's stored Connect account
   - `customer_payments_immutable` re-created with the three ids added to its never-changes list
4. `automation_incidents`: the `online_payment_reconciliation` category, added to the category CHECK and to `record_automation_incident_signal`'s allowlist. That function is re-created from `reference/record_automation_incident_signal.captured.sql` with only that one line added.

**Stripe Accounts v2 mapping (documentation only; the SQL is unchanged).** Connected accounts are created and read with the Accounts v2 API (`/v2/core/accounts`, in `lib/payments/connect.ts`), because Stripe no longer supports v1 account creation for new Connect integrations. The five organizations columns keep their names and are filled from a v2 account retrieved with `include: ["configuration.merchant", "requirements"]`:

- `stripe_connect_account_id`: the v2 account id. It's still `acct_…`, so the shape check and unique index hold.
- `stripe_connect_charges_enabled`: `configuration.merchant.capabilities.card_payments.status` is `active`.
- `stripe_connect_payouts_enabled`: `configuration.merchant.capabilities.stripe_balance.payouts.status` is `active`.
- `stripe_connect_details_submitted`: v2 has no such field. The column now means "onboarding requirements satisfied": the requirements hash has no entry awaiting the user with `minimum_deadline.status` of `currently_due` or `past_due`. It's false when the hash is absent.
- `stripe_connect_synced_at`: unchanged.

The column names still say "details submitted" because renaming them would need a migration for no behavioral gain. Only the Settings detail text reads that column; online-payment eligibility never does.

The accounting boundary is unchanged. `customer_payments_guard_insert`, `customer_payments_apply`, the three invoice guards, `create_invoice_audit_event` and `merge_contacts` aren't touched (the harness compares their md5s). No policy or table grant changes. An online payment is recorded only through the existing insert path, so the overpayment, issued-invoice and append-only rules all still apply. When the database refuses money Stripe has already collected, the Connect webhook must raise an `online_payment_reconciliation` incident. The migration adds nothing that could bypass a rule.

Companion files:

- `online_payments_rollback.sql` refuses to run while any `card_online` payment, any `online_payment_reconciliation` incident, or any stored Connect account id exists. It then restores `customer_payments_immutable` (the 20260928181837 body) and `record_automation_incident_signal` (the captured body) byte-for-byte, restores the narrower CHECKs, and drops everything else the forward script added.
- `reference/record_automation_incident_signal.captured.sql` is the function body read from **trackpr-stripe-test**, not production (md5 `dfca7377dd707f2cd7814f87ae84a6bf`, 3554 characters).
- `scratch/validate-online-payments.mjs` (77 checks) reproduces the starting state from the three applied invoice migrations. It first proves parity with trackpr-stripe-test by matching three function md5s. Then it applies the script twice, exercises every rule (including the accounting-boundary cases and replays), runs each rollback guard and the rollback, and applies once more. Run it with `cd supabase/pending/scratch && npm run validate:online-payments`. It never connects to a real database.
- `lib/payments/online-payments-migration.structural.test.ts` pins the source text: which functions are created, the byte-for-byte body diffs, no policy changes, rerun safety.

### Apply procedure (a person does this, not tooling)

The test project goes first. Production needs separate, explicit approval.

1. Read the target's live `record_automation_incident_signal` and confirm the md5 is `dfca7377dd707f2cd7814f87ae84a6bf`. Use the query in the reference file's header. If it differs, stop: section 4 and the rollback must be rebased on the live body.
2. Confirm the live `customer_payments_immutable` md5 is `b2be41a0c1f3458e1ca3c6a1df592c39`, and that none of the new columns exist yet: `select column_name from information_schema.columns where table_schema = 'public' and column_name in ('stripe_connect_account_id', 'payment_token', 'stripe_checkout_session_id')` should return no rows.
3. Apply `online_payments.sql` as one transaction, using the Supabase SQL editor or the MCP `apply_migration` tool with the name `online_payments`. The script wraps itself in `begin; … commit;`. If the mechanism supplies its own transaction, apply it without those two lines.
4. Read back the ledger entry: `select version, name from supabase_migrations.schema_migrations order by version desc limit 1`.
5. Verify read-only:
   - the new columns, indexes and constraints
   - the three new triggers
   - `record_automation_incident_signal` now allowing `online_payment_reconciliation`
   - the untouched functions' md5s unchanged
   - every existing invoice has a 48-hex `payment_token`
6. Only after production has it: `git mv supabase/pending/online_payments.sql supabase/migrations/<recorded production version>_online_payments.sql`. Leave the rollback and reference files in place.

### Status

**trackpr-stripe-test (lwofqffxagxiqodqvcfr):** applied on 2026-09-28 through the MCP `apply_migration` mechanism, named `online_payments`, as the file's exact text minus its `begin;`/`commit;` lines (the mechanism supplies the transaction). It's recorded as ledger version `20260928232804` (ledger count went from 69 to 70). Checks before the apply:
- production's `record_automation_incident_signal` md5 was `dfca7377dd707f2cd7814f87ae84a6bf` and its `customer_payments_immutable` md5 was `b2be41a0c1f3458e1ca3c6a1df592c39`, matching the reference, so there was no drift
- the target had no Phase 1C objects

Verified afterwards:
- `md5(prosrc)` of all five created or replaced functions equals the md5 of the matching body text in this file
- the 9 columns, 5 constraints (all validated), 4 unique indexes and 3 triggers are present
- the seven accounting functions' md5s are identical before and after
- grants and the incident function's privileges are unchanged
- a probe run inside one transaction that always rolled back passed 12/12 guard checks under real JWT-claim roles, and left no rows behind

**Production:** not applied. Its ledger is still at 52 rows, latest `20260928181837`. The file stays in `supabase/pending/` until production has it.

## dashboard_sql.sql (PENDING - not applied anywhere)

Phase 2D: three read-only functions for the Dashboard (`app/(app)/today/page.tsx`) - `dashboard_summary`, `dashboard_conversation_attention`, `dashboard_briefing` - that count and sum over an organization's complete data instead of the capped row reads summed in TypeScript. Additive only: no tables, indexes or policies. Each function is `language sql stable security invoker set search_path = public`, filters `organization_id` explicitly, and leaves RLS (membership and the payment gate) authoritative. EXECUTE is revoked from PUBLIC and anon and granted to authenticated.

- `dashboard_sql_rollback.sql` drops the three functions. Deploy application code that no longer calls them first.
- `scratch/validate-dashboard-sql.mjs` builds the full schema in PGlite from `migrations/` plus `online_payments.sql`, seeds five organizations (empty, normal with timezone and boundary cases, isolation, one above every old row cap with 1,000-5,100 rows per table, and one with more than five responded review and referral requests), and proves parity with the TypeScript loaders through a PostgREST-compatible adapter (`scratch/pglite-postgrest.mjs`). Run from the repo root, under both `TZ=UTC` and `TZ=America/Los_Angeles`: `node --import ./lib/automation/test-loader.mjs supabase/pending/scratch/validate-dashboard-sql.mjs verify` (add `EXPLAIN=<dir>` for plans). `capture` re-freezes the pre-2D baseline from the legacy loaders, which still exist.
- One intentional behavior change: responded review/referral requests on the owner briefing are ordered `created_at ASC, id ASC`. The previous reads had no ORDER BY, so their order - and which five were shown when more than five existed - was undefined.

### Apply procedure

The test project goes first. Production needs separate, explicit approval.

1. Confirm the functions don't exist yet: `select proname from pg_proc where proname like 'dashboard\_%'`.
2. Apply `dashboard_sql.sql` as one transaction (SQL editor, or MCP `apply_migration` named `dashboard_sql` without the file's `begin;`/`commit;` lines).
3. Read back the ledger entry and verify: three functions, `prosecdef = false`, `provolatile = 's'`, `proconfig = {search_path=public}`; `has_function_privilege('anon', ...)` false and `('authenticated', ...)` true for each.
4. Only after production has it: `git mv` the file into `supabase/migrations/<recorded production version>_dashboard_sql.sql`.

### Status

**trackpr-stripe-test (lwofqffxagxiqodqvcfr):** applied on 2026-09-29 through the Supabase SQL Editor, as the file's exact text including its `begin;`/`commit;` (SHA-256 `c838d808ddb3756a7b6a10f44c79f62784a7a339fab26f7eec949782dfce82e4`), one run, "Success. No rows returned." The SQL Editor records no ledger row, so the ledger stays at 70 rows. Read back: the three `prosrc` md5s match the file (`dashboard_summary` ff609e83..., `dashboard_conversation_attention` ca19763c..., `dashboard_briefing` 0542e68c...), all `sql`, SECURITY INVOKER, STABLE, `search_path=public`; EXECUTE held by authenticated and service_role (project default privileges), not by anon or PUBLIC. Live checks as `authenticated`: a member of another organization gets all zeros and empty lists; the owner gets their own figures; anon gets `permission denied`.

**Production (mywznmxtlgajnczjvbmk):** not applied.

## dashboard_attention_sql.sql (PENDING - applied to TEST only)

Phase 2E: one read-only function, `dashboard_record_attention(p_organization_id uuid, p_now timestamptz, p_high_value_threshold numeric) returns jsonb`, replacing the three capped reads left inside `getDashboardData` on the Today page - leads (newest 500), appointments (latest start 200), estimates (500, unordered). It returns the five record-backed attention lists (overdue_appointment, awaiting_confirmation, hot_lead, high_value_lead, pending_estimate; at most 5 each, same order), the uncontacted_lead de-duplication set, the recent-activity inputs, and the overview and pipeline counts - all over complete data. `language sql stable security invoker set search_path = public`, explicit `organization_id` filters, EXECUTE revoked from PUBLIC and anon and granted to authenticated. No tables, indexes or policies. `dashboard_sql.sql` is unchanged and still required.

- `dashboard_attention_sql_rollback.sql` drops the function. Deploy application code whose `getDashboardSqlData` no longer passes `recordAttention: "sql"` first.
- Parity: `scratch/validate-dashboard-sql.mjs` (same commands as above) adds a boundary org for every rule, a timestamp-tie org, an org above all three caps, and leads-only clones so every mapped attention field is compared with the legacy loader.
- Approved contract: ties on the ordering timestamp (lead `created_at`; appointment `start_at`, which can only tie on cancelled/no-show rows) are broken by `id ASC`. The legacy reads ordered by the timestamp alone, so tied rows came back in an undefined order.

### Status

**trackpr-stripe-test (lwofqffxagxiqodqvcfr):** applied on 2026-09-29 through the Supabase SQL Editor as the file's exact text (SHA-256 `e39af36f61ffd3cd3b9cfd76f427f2a9c2c65dfc5f972438df0408c26631fa27`), one run, "Success. No rows returned." No ledger row (ledger still 70). Read back: body md5 `f17d4223aee00519901179afd2e82e11` matches the file; `sql`, SECURITY INVOKER, STABLE, `search_path=public`; anon and PUBLIC cannot execute, authenticated can.

**Production (mywznmxtlgajnczjvbmk):** not applied. To promote, production needs both `dashboard_sql.sql` and then `dashboard_attention_sql.sql`, each applied once and moved into `supabase/migrations/` under the ledger version its apply records.

## opportunity_sync_state.sql (moved to supabase/migrations/20260930025936_opportunity_sync_state.sql)

Performance Pass 2 (Opportunity Sync Throttling): an atomic, per-organization 5-minute cooldown for the Dashboard's background opportunity sync (`after()` -> `syncOpportunities`, ~28 reads per Dashboard view with no cross-request dedup). Two additive objects; nothing existing is altered:

1. `public.opportunity_sync_state (organization_id uuid primary key references organizations on delete cascade, last_started_at timestamptz not null)`: RLS enabled with no policies, and every table privilege revoked from PUBLIC, anon and authenticated (the project's default privileges would otherwise grant them ALL). service_role keeps its default grants and is never used by the feature.
2. `public.claim_opportunity_sync(p_organization_id uuid) returns boolean`: `plpgsql volatile security definer set search_path = 'public'`, EXECUTE revoked from PUBLIC and anon and granted to authenticated. Returns false (never an error, so no existence signal) unless `auth.uid()` is set, `is_org_member()` and `organization_payment_active()` - the existing helpers, called rather than copied - both hold. Then one `INSERT ... ON CONFLICT (organization_id) DO UPDATE ... WHERE last_started_at <= now() - interval '5 minutes' RETURNING true`: exactly one concurrent caller wins per organization per 5 minutes. The cooldown is fixed inside the function; a failed or aborted sync keeps its claim until it expires.

Application side: `lib/opportunities/background-sync.ts` calls the claim first inside the existing `after()` task, on the same user-JWT client, and skips the sync on false (quietly) or on an error/throw (logged as `[opportunities] background sync skipped: claim failed`). `/today`, `syncOpportunities` and the detectors are unchanged.

Companion files:

- `opportunity_sync_state_rollback.sql` drops the function, then the table.
- `scratch/validate-opportunity-sync-state.mjs` (`cd supabase/pending/scratch && npm run validate:opportunity-sync-state`) reproduces the starting state in PGlite, including the project's default privileges, and proves: idempotent apply; owner/admin/member win, a second claim inside the cooldown loses, a claim after >5 minutes wins; non-member, payment_required, suspended, cancelled, null organization, nonexistent organization and no `auth.uid()` all get false and write nothing; a cross-organization claim loses and leaves the other row untouched; anon and PUBLIC cannot execute; direct SELECT/INSERT/UPDATE/DELETE is denied to authenticated and anon; the cooldown can't be passed in; organization deletion cascades; rollback and re-apply. It cannot prove concurrency (single connection) - that is `lib/opportunities/sync-claim.integration.test.ts`, run against the test project after it is applied there.

### Deploy order (critical)

The application code depends on the function: deployed without it, every claim fails and every sync is skipped - opportunities would stop refreshing. So: apply to the test project, run the integration test, apply to production and verify, and only then merge the application code. To undo, revert the application code first; the table and function are inert without it, so the rollback script is optional.

### Apply procedure (a person does this, not tooling)

1. Confirm neither object exists: `select to_regclass('public.opportunity_sync_state'), to_regprocedure('public.claim_opportunity_sync(uuid)')` should both be null.
2. Apply `opportunity_sync_state.sql` as one transaction (MCP `apply_migration` named `opportunity_sync_state`, or the SQL editor wrapped in `begin;`/`commit;`). The file is idempotent.
3. Read back the ledger entry, if the mechanism records one: `select version, name from supabase_migrations.schema_migrations order by version desc limit 1`.
4. Verify read-only: the table exists with `relrowsecurity = true`, zero policies, and no privileges for anon or authenticated; the function has `prosecdef = true`, `provolatile = 'v'`, `proconfig = {search_path=public}`, one argument; `has_function_privilege('anon', ...)` false and `('authenticated', ...)` true; all other public policies and functions unchanged.
5. On the test project, run `lib/opportunities/sync-claim.integration.test.ts`.
6. Only after production has it: `git mv` the file into `supabase/migrations/<recorded production version>_opportunity_sync_state.sql`.

### Status

Written and validated locally (PGlite, 48 checks). File SHA-256 `454449e80dfad8922597a908b7c68da106abbebfbd51fb1936a32665a2e33d87`.

**trackpr-stripe-test (lwofqffxagxiqodqvcfr):** applied on 2026-09-30 via the MCP `apply_migration` mechanism with the name `opportunity_sync_state`, once, as the file's exact text. Recorded as ledger version `20260930025545` (ledger 70 -> 71). Verified read-only afterwards: table owned by postgres, RLS enabled and not forced, zero policies, primary key plus `on delete cascade`, privileges held only by postgres and service_role (none for anon or authenticated); function `plpgsql`, SECURITY DEFINER, VOLATILE, `search_path=public`, one argument, the fixed `interval '5 minutes'`, EXECUTE for authenticated and not for anon or PUBLIC (service_role also holds EXECUTE through the project's default privileges; the feature never uses it). All 125 public policies (md5 `4e9dfbad32a15c0dea507874bc25ec37`) and the other 228 public functions (md5 `0f82023ae2960fe5483e5bfa5bfd4820`) are byte-identical before and after. `lib/opportunities/sync-claim.integration.test.ts`: 9/9, including 10 simultaneous claims -> exactly one winner (twice), the real 5-minute boundary, organization independence, membership and payment gating, and anon/direct-table denial (a fresh anonymous client gets `42501 permission denied`); its fixtures cleaned up completely.

**Production (mywznmxtlgajnczjvbmk):** applied on 2026-09-30 via the MCP `apply_migration` mechanism with the name `opportunity_sync_state`, once, as the same exact text (file SHA-256 `454449e8...`; the ledger's recorded statements hash `8f124231aa63e81f700dde1d9ab0ad7d` is identical to the test project's). Recorded as ledger version `20260930025936` (ledger 54 -> 55). Verified read-only afterwards: the same table, grants and function as on the test project (body md5 `9bccaaf212ac9779dd3ff6f490379627`, identical), zero rows. Unchanged, by before/after fingerprints: all 125 public policies (md5 `4e9dfbad32a15c0dea507874bc25ec37`), the other 228 public functions including their ACLs, the other 39 public tables' columns, constraints, indexes, triggers, table grants and RLS flags. The only new public relations are the table and its primary-key index. The integration test was not run against production (it creates disposable users and organizations). The application code that calls the claim is not yet deployed; the table and function are inert until it is.

The file now lives at `supabase/migrations/20260930025936_opportunity_sync_state.sql`, unmodified (md5 `643adae268109b827b8ab698bf08ee6f`, identical to the statement production's ledger recorded); its header comment still reads "STATUS: PENDING" because the SQL text is deliberately kept byte-identical to what was applied. The rollback file and the PGlite harness stay here; the harness now reads the migration from its `supabase/migrations/` location.

## organization_health_inputs.sql (moved to supabase/migrations/20260930044405_organization_health_inputs.sql)

Performance Pass 3 (Dashboard automation-health consolidation): one read-only function, `public.organization_health_inputs(p_organization_id uuid, p_executions_from timestamptz, p_executions_to timestamptz) returns jsonb`, that returns every input `computeOrganizationHealth()` in `lib/automation-health/health.ts` needs. It replaces the six PostgREST requests that function made on every call (the top bar on every full (app) page load, the Dashboard's system status, the automations page, the briefing, and the agency views). One additive object; nothing existing is altered.

- `language sql stable security invoker set search_path = public`, explicit `organization_id` filters, EXECUTE revoked from PUBLIC and anon and granted to authenticated. This is the dashboard_* functions' convention. Every read runs under the caller's own RLS, the same policies the six reads ran under. service_role also holds EXECUTE through the project's default privileges, and the agency callers that use a service-role client keep working exactly as before.
- It returns five keys, each mirroring one old read exactly:
  - `window_status_counts` mirrors `getAutomationAndFollowUpMetrics`' workflow_executions read: last-30-days window, 10,000-row cap.
  - `name_stats` mirrors `getWorkflowNameStats`: the newest 500 executions, reduced to the latest status and timestamp plus the failed count per workflow.
  - `incidents` mirrors `listIncidents`: the newest 200 open or acknowledged incidents, category and severity only.
  - `organization` holds payment_status and automation_paused.
  - `liveness` holds `get_scheduled_automation_liveness()`'s rows, unchanged.
- It no longer reads `automation_events`, which the old overview read but the health summary never used.
- The window is passed in and computed by the same `resolveDateRange("last30Days")` as before, so its bounds are byte-identical. That is why the function takes three arguments.

Application side: `computeOrganizationHealth()` makes one `supabase.rpc("organization_health_inputs", ...)` call; every calculation after that is the existing TypeScript, unchanged. On an error it treats the inputs as empty. That is exactly the summary the old code produced when all six reads failed: fail closed to `payment_blocked`, zero counts, nothing stale. The old per-read partial degradation is gone: the reads now succeed or fail together.

Companion files:

- `organization_health_inputs_rollback.sql` drops the function. Revert the application code first.
- `scratch/validate-organization-health-sql.mjs` (run from the repo root: `node --import ./lib/automation/test-loader.mjs supabase/pending/scratch/validate-organization-health-sql.mjs`, under both `TZ=UTC` and `TZ=America/Los_Angeles`) boots PGlite from the real migrations. It runs the origin/main six-read `health.ts` and the new one-RPC `health.ts` side by side through supabase-js over `pglite-postgrest.mjs`, and requires an identical `OrganizationHealthSummary` (every field but `generatedAt`) for these organizations:
  - normal (every execution and incident status, severity and special category);
  - empty, paused, payment_required, suspended and cancelled;
  - more than 500 executions and more than 200 incidents;
  - more than 10,000 in-window executions;
  - exact window boundaries;
  - only out-of-window history;
  - a nonexistent organization.

  It also proves:
  - 6 requests become 1;
  - identical fail-closed output when the database is unreachable;
  - a member reads their organization, a non-member gets nothing of it, and anon is denied;
  - the object inventory is correct and a second apply is idempotent;
  - rollback followed by re-apply works.

  The harness makes 47 checks. `lib/automation-health/health-inputs.test.ts` covers the call shape and the mapping at unit level.

### Deploy order (critical)

The application code depends on the function. If the code is deployed without it, every health read fails, and every page that shows health reports `payment_blocked` with zero counts. So: apply to the test project, verify, apply to production and verify, and only then merge the application code. To undo, revert the application code first; the function is inert without it.

### Apply procedure (a person does this, not tooling)

1. Confirm it does not exist: `select to_regprocedure('public.organization_health_inputs(uuid, timestamptz, timestamptz)')` should be null.
2. Apply `organization_health_inputs.sql` as one transaction (MCP `apply_migration` named `organization_health_inputs`, or the SQL editor wrapped in `begin;`/`commit;`). The file is idempotent.
3. Read back the ledger entry: `select version, name from supabase_migrations.schema_migrations order by version desc limit 1`.
4. Verify read-only:
   - `prosecdef = false`, `provolatile = 's'`, `proconfig = {search_path=public}`;
   - `has_function_privilege('anon', ...)` is false and `('authenticated', ...)` is true;
   - every other public function and policy is unchanged.
5. Only after production has it: `git mv` the file into `supabase/migrations/<recorded production version>_organization_health_inputs.sql`.

### Status

Written and validated locally (PGlite, 47 checks, under both time zones). File SHA-256 `586a0c30a666e0ce5ec60503a9f11f22918533b53d6febe00b09dd03171dd5e9`.

**trackpr-stripe-test (lwofqffxagxiqodqvcfr):** applied on 2026-09-30 via the MCP `apply_migration` mechanism with the name `organization_health_inputs`, once, as the file's exact text. Recorded as ledger version `20260930035749` (ledger 71 -> 72). Verified read-only afterwards:
- byte-identical: the ledger's recorded statement md5 `64ce08bbf039a3795641132e1b54d15b` equals the file's md5, and the stored function body md5 `485b061390a5b817d401c486aca1c637` equals the file's body;
- `sql`, STABLE, SECURITY INVOKER, `search_path=public`, 3 arguments, returns `jsonb`;
- EXECUTE for authenticated and not for anon or PUBLIC (service_role also holds EXECUTE through the project's default privileges);
- policies, other functions, columns, relations, constraints, triggers, indexes and default privileges byte-identical before and after.

Integration checks on the test project: the automation-health integration and security suites pass (the agency health suite could not run: it needs an agency-admin fixture user that does not exist on this project). A live check with real JWTs showed identical legacy and new summaries for every organization and for a member, nothing for a non-member, and `42501` for anon; its fixtures were removed. Previews against the test project showed 25 -> 20 Dashboard and 17 -> 12 full-load /people Supabase calls before the response, and identical health on screen.

**Production (mywznmxtlgajnczjvbmk):** applied on 2026-09-30 via the MCP `apply_migration` mechanism with the name `organization_health_inputs`, once, as the same exact text. Recorded as ledger version `20260930044405` (ledger 55 -> 56). Verified read-only afterwards: the same statement md5 `64ce08bb...` and function body md5 `485b0613...` (full definition md5 `15da2c51a7267e93a468a3e6fd0e3bca`, identical to the test project's), the same properties and grants, and every other fingerprint unchanged; the function is the only new object. No behavioural tests were run against production. The application code that calls the function is not yet deployed; the function is inert until it is.

The file now lives at `supabase/migrations/20260930044405_organization_health_inputs.sql`, unmodified (SHA-256 `586a0c30...`, md5 `64ce08bb...`, identical to the statement production's ledger recorded); its header comment still reads "STATUS: PENDING" because the SQL text is deliberately kept byte-identical to what was applied. The rollback file and the PGlite harness stay here; the harness now reads the migration from its `supabase/migrations/` location.

## scheduler_version_control.sql

**Applied to production 2026-10-02 (ledger `20261002102849`); now at `supabase/migrations/20261002102849_scheduler_version_control.sql` - see Status below.**

Phase 3D (Scheduler Reliability). Production's business scheduler is Supabase pg_cron + pg_net: seven jobs (`trackpr_appointment_reminders`, `trackpr_estimate_followups`, `trackpr_lead_nurture`, `trackpr_lead_reactivation`, `trackpr_customer_reactivation`, `trackpr_no_show_detection`, `trackpr_automation_health`) that run `select public.invoke_trackpr_scheduled('<route>')` every 15 minutes, staggered one minute apart. Until this script, none of it lived in the repository. It was captured read-only on 2026-10-02 - job names and schedules from `cron.job`, the helper body from `pg_get_functiondef` - without reading any secret.

What the script does:

1. Re-creates `public.invoke_trackpr_scheduled(p_path text)` byte-for-byte from production, with exactly one change: `/api/automation/opportunity-sync` is added to its route allowlist. Vault secret names (`trackpr_base_url`, `trackpr_cron_secret`), the https-origin check, the GET, the Bearer header and the 300000 ms timeout are unchanged. No secret, URL or token is in the file. Owner stays `postgres`; EXECUTE is revoked from public, anon, authenticated and service_role (as in production).
2. Re-declares the seven jobs with their exact names, schedules and commands - `cron.schedule` with an existing name updates that job in place - and adds `trackpr_opportunity_sync` at `7,22,37,52 * * * *`. It refuses if a same-named job belongs to another role (pg_cron would create a duplicate) and verifies exactly one job per name. `trackpr_cron_history_cleanup` is not touched and stays inactive.
3. The job section does nothing unless pg_cron is installed and both Vault secrets exist, so applying it to a database without the scheduler (TEST) creates no failing jobs.

Not managed here: the pg_cron / pg_net extensions and the Vault secrets (created per environment by a person).

Companion files:

- `scheduler_version_control_rollback.sql` unschedules `trackpr_opportunity_sync` and restores the helper's exact pre-Phase-3D body (seven paths), leaving the seven jobs - already identical to before - and the cleanup job alone. See "Rollback order" below.
- `scratch/validate-scheduler-version-control.mjs` applies the script to PGlite with stand-in cron/vault/net schemas (dummy values only): skip without pg_cron or Vault; existing jobs updated in place with the same job ids; idempotent; cleanup untouched; helper behavior (8 paths, https check, Bearer header, timeout); grants revoked; refusal on a job owned by another role; and the rollback.

### Deploy order

Deploy the application code first (the `/api/automation/opportunity-sync` route and the watchdog). Applying the script before the route exists would make `trackpr_opportunity_sync` call a 404 every 15 minutes - harmless (no data change) but noisy, and its liveness would show the route as never having run.

### Apply procedure (a person does this, not tooling)

1. Read-only, names only: `select jobid, jobname, schedule, active from cron.job order by jobid` - confirm the seven jobs and schedules above, and that no `trackpr_opportunity_sync` exists yet. `select name from vault.secrets order by name` - confirm both secret names. Never select `command` or decrypted values.
2. Apply `scheduler_version_control.sql` as one transaction (MCP `apply_migration` named `scheduler_version_control`, or the SQL editor keeping its `begin;`/`commit;`).
3. Read back the ledger entry: `select version, name from supabase_migrations.schema_migrations order by version desc limit 1`.
4. Verify read-only: the same `cron.job` query shows the seven jobs with the SAME jobids and schedules, `trackpr_opportunity_sync` once at `7,22,37,52 * * * *`, and `trackpr_cron_history_cleanup` still inactive; `has_function_privilege` for anon, authenticated and service_role on `public.invoke_trackpr_scheduled(text)` is false.
5. Watch Vercel's request logs for one cycle: the seven routes plus `/api/automation/opportunity-sync`, all 200.
6. Only after production has it: `git mv` the file into `supabase/migrations/<recorded production version>_scheduler_version_control.sql`.

### Rollback order

1. Revert/redeploy the application code first, so `opportunity-sync` is no longer tracked as an expected scheduled automation (`SCHEDULED_AUTOMATION_IDS`).
2. Then run `scheduler_version_control_rollback.sql`.

Why: running the SQL rollback while the Phase 3D code is still deployed removes `opportunity-sync`'s schedule while the liveness catalog still expects it. Its liveness becomes stale after ~45 minutes, and `/api/automation/health` (and the daily watchdog) would then raise the customer-facing "Automation needs attention" alert to every live, paying organization's owners - a false alarm. The reverse order is harmless: with the old code deployed, the still-scheduled job only gets a 404, with no side effects, until the SQL rollback removes it.

### Status

**Applied and version-controlled - no longer pending.** Written and validated locally (PGlite, 7 scenario checks). File SHA-256 `7f4ad2c588fb2bb153ac13ccbefc97d97d2fedf5597f60cbd7e5e8784c793c64`.

**Production (mywznmxtlgajnczjvbmk):** applied on 2026-10-02, after the application code (PR #34, `0e05817`) was deployed, via the MCP `apply_migration` mechanism with the name `scheduler_version_control`, once, as the file's exact text (SHA-256 `7f4ad2c5...`), as `postgres`. Recorded as ledger version `20261002102849`. Read-only preflight beforehand: `current_user` `postgres`; jobs 1-7 present once each, active, owned by `postgres`, with the expected schedules; no `trackpr_opportunity_sync`; `trackpr_cron_history_cleanup` inactive; the live helper body identical to the rollback file's. Verified read-only afterwards:
- jobs 1-7 kept their job ids, schedules, commands and `active = true`; `trackpr_opportunity_sync` exists once (job id 16), active, at `7,22,37,52 * * * *`, with the expected command; `trackpr_cron_history_cleanup` still inactive; no other jobs;
- the helper body equals the forward script's (the seven paths plus `/api/automation/opportunity-sync`; same Vault names, https-origin check, Bearer header, 300000 ms timeout, no retry); owner `postgres`, not SECURITY DEFINER, ACL `{postgres=X/postgres}` - no EXECUTE for anon, authenticated or service_role;
- the first natural `trackpr_opportunity_sync` run (10:37 UTC) succeeded: `GET /api/automation/opportunity-sync` returned 200, an `opportunity-sync` row was written to `automation_schedule_runs`, and `/automations` shows Opportunity Detection as "Observed recently". The seven existing routes kept returning 200.

**trackpr-stripe-test:** not applied (it has no scheduler; the script would only re-create the helper there).

The file now lives at `supabase/migrations/20261002102849_scheduler_version_control.sql`, unmodified (SHA-256 `7f4ad2c5...`, identical to what production applied); its header comment still reads "STATUS: PENDING" because the SQL text is deliberately kept byte-identical to what was applied. The rollback file and the PGlite harness stay here; the harness and `lib/automation-health/scheduler-config.structural.test.ts` now read the migration from its `supabase/migrations/` location.
