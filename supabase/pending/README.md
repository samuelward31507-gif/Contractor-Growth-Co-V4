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

## dashboard_sql.sql (PENDING - not applied anywhere)

Phase 2D: three read-only functions for the Dashboard (`app/(app)/today/page.tsx`) - `dashboard_summary`, `dashboard_conversation_attention`, `dashboard_briefing` - that count and sum over an organization's complete data instead of the capped row reads summed in TypeScript. Additive only: no tables, indexes or policies. Each function is `language sql stable security invoker set search_path = public`, filters `organization_id` explicitly, and leaves RLS (membership and the payment gate) authoritative. EXECUTE is revoked from PUBLIC and anon and granted to authenticated.

- `dashboard_sql_rollback.sql` drops the three functions. Deploy application code that no longer calls them first.
- `scratch/validate-dashboard-sql.mjs` builds the full schema in PGlite from `migrations/` (production's schema), seeds five organizations (empty, normal with timezone and boundary cases, isolation, one above every old row cap with 1,000-5,100 rows per table, and one with more than five responded review and referral requests), and proves parity with the TypeScript loaders through a PostgREST-compatible adapter (`scratch/pglite-postgrest.mjs`). Run from the repo root, under both `TZ=UTC` and `TZ=America/Los_Angeles`: `node --import ./lib/automation/test-loader.mjs supabase/pending/scratch/validate-dashboard-sql.mjs verify` (add `EXPLAIN=<dir>` for plans). `capture` re-freezes the pre-2D baseline from the legacy loaders, which still exist.
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
