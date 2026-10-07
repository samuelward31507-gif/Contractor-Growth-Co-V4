# Trackpr release, rollback and recovery runbook

For the person operating a Trackpr production release (Batch 5) or responding to a production incident. It uses only infrastructure that exists today:

- **Application:** a Next.js app on Vercel.
- **Database:** Supabase Postgres, with Production and TEST as separate projects.
- **Scheduler:** Supabase pg_cron + pg_net.
- **Watchdog:** one Vercel Cron job.
- **Other services:** n8n (AI drafting), Twilio (SMS/voice), Stripe (billing and Connect payments) and Resend (email).

Credentials are never written here. Wherever a step needs one, it names the dashboard or variable, not the value.

Day-to-day onboarding lives in [operator-runbook.md](./operator-runbook.md). Pending database changes and their apply procedure live in [`supabase/pending/README.md`](../supabase/pending/README.md).

---

## 0. Map of moving parts

| Part | Where it lives | Notes |
|---|---|---|
| App code | Git branch → Vercel deployment | Production = the deployment promoted to Production in Vercel |
| Database schema | `supabase/migrations/` (applied) and `supabase/pending/` (not yet applied to Production) | The Supabase migration ledger is `supabase_migrations.schema_migrations` |
| Scheduler | pg_cron jobs `trackpr_*`; each one calls `public.invoke_trackpr_scheduled('<path>')` | That function reads Vault secrets `trackpr_base_url` (https origin) and `trackpr_cron_secret` |
| Scheduled routes | `trackpr_appointment_reminders`, `trackpr_estimate_followups`, `trackpr_lead_nurture`, `trackpr_lead_reactivation`, `trackpr_customer_reactivation`, `trackpr_no_show_detection`, `trackpr_automation_health`, `trackpr_opportunity_sync` | All every 15 minutes, staggered by a minute each. Owner digest and invoice reminders have their own schedule files; check `cron.job` for what actually exists. TEST has no cron. |
| Health tick | `/api/automation/health`, every 15 minutes, from pg_cron | Reaps timed-out executions, classifies and runs retries, dispatches follow-ups, scans for stuck runs, then writes the heartbeat row `automation_health_check_runs` **only when every phase succeeded** |
| Watchdog | `/api/automation/scheduler-watchdog`, Vercel Cron once a day at 14:30 UTC (`vercel.json`) | Alerts if the heartbeat is older than 45 minutes or a scheduled route is stale |
| Liveness | `GET /api/health` (public) | 200 = app + database + scheduler OK, 503 otherwise. No organization or customer data. |
| Ops alerts | Structured log lines containing `"trackpr_ops_alert":true` (Vercel function logs) | Watchdog alerts are also emailed to `OPS_ALERT_EMAIL` when configured |
| n8n | Production workflow `KxH5Fby3XgJVP6Kj` (AI drafting); it calls back `/api/automation/n8n-callback` | Never edited outside an authorized release |
| Twilio | Number webhooks → `/api/webhooks/sms/inbound`, `/api/webhooks/voice/inbound`; delivery status → `/api/webhooks/sms/status` | |
| Stripe | Billing webhook `/api/webhooks/stripe`; Connect webhooks `/api/webhooks/stripe-connect`, `/api/webhooks/stripe-connect/accounts` | |

Release checkpoints are git tags on branch `trackpr-test-lifecycle`: `checkpoint/post-batch-1` … `checkpoint/post-batch-4`, plus earlier `checkpoint/*` tags. `main` is untouched until the release.

---

## 1. Configuration the release needs (set before Batch 5 deploys)

Set every value in Vercel → Project → Settings → Environment Variables, scoped to **Production** (or **Preview** for TEST). Never commit a value.

| Variable | Required? | Purpose |
|---|---|---|
| `APP_CANONICAL_URL` | Optional | Production's canonical https origin (e.g. a custom domain). It must be an https origin with no path and not localhost; otherwise it is ignored and the built-in default `https://contractor-growth-co-v4.vercel.app` is used. `APP_BASE_URL` is **not** read in Production. |
| `APP_BASE_URL` | Preview/TEST | That environment's own https URL (links in SMS, emails, OAuth redirects). |
| `OPS_ALERT_EMAIL` | Recommended | Operator inbox for watchdog alerts. Uses the existing `RESEND_API_KEY` and `EMAIL_FROM`. Without it, alerts are log-only. |
| `CRON_SECRET` | **Required** | Shared bearer for every scheduled route; must equal Vault `trackpr_cron_secret`. When it is missing, every scheduled call is refused and a `cron_secret_missing` ops alert is logged. |
| `STRIPE_SECRET_KEY` / `STRIPE_CONNECT_SECRET_KEY` | **Required (live in Production)** | A live key is refused outside Vercel Production. A test key is refused **in** Vercel Production unless `STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION=true`. |
| `STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION` | Only for a deliberate rehearsal | Set to exactly `true` only while intentionally running Production on Stripe test keys. Remove it before taking real payments. |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET` | Required where used | Must belong to webhook endpoints registered in the **same Stripe mode** as the key. Events of the other mode are refused with HTTP 400 and a `stripe_event_mode_mismatch` ops alert. |

Outside Vercel, also check:

1. **Supabase Vault:** `trackpr_base_url` must be Production's canonical https origin, matching `APP_CANONICAL_URL` or the default.
2. **External uptime monitor:** point any HTTP monitor at `GET https://<canonical>/api/health`, alerting on non-200. This is the only check that still works if both pg_cron and Vercel Cron stop. No such service is configured in the repository; choose one during Batch 5.
3. **Vercel function duration:** in Vercel → Settings → Functions, confirm the maximum duration is at least 60 seconds. The health tick runs retries and follow-up dispatch in one request. No `maxDuration` is set in code, because the right value depends on the Vercel plan.

---

## 2. Release order and checkpoints (Batch 5)

Database first, then app, then integrations. Stop at any checkpoint that fails.

1. **Freeze:** record the current Production deployment in Vercel (Deployments → the one marked Production) as the rollback target, and record the current n8n workflow version.
2. **Database:** apply each pending file listed in `supabase/pending/README.md` for this release, one transaction each, then read back the ledger. These are additive (new columns, functions, indexes), so the currently deployed app keeps working on the new schema.
   - **Checkpoint DB:** every expected version is present (§4), and `GET /api/health` is still 200.
3. **App:** promote the release build to Production.
   - **Checkpoint APP:** §7 checks pass within 30 minutes. Allow two health ticks before reading the heartbeat.
4. **Integrations:** n8n and any webhook changes come only after APP passes.
   - **Checkpoint INTEGRATIONS:** one real round trip each (inbound SMS → AI draft → send; a Stripe test event in the same mode).

---

## 3. Rolling the application back (Vercel)

The fastest safe action for a bad deploy, as long as the database is still compatible (§6).

1. Vercel dashboard → Project → **Deployments** → the previous Production deployment recorded at Freeze → **⋯ → Instant Rollback** (or **Promote to Production**). With the CLI: `vercel rollback <deployment-url>`.
2. Do **not** push a git revert to make this happen. The rollback re-points Production at an existing build; git history is fixed afterwards on a branch.
3. Environment-variable changes made for the release are **not** reverted by an Instant Rollback. Revert them by hand only if the older build cannot run with them. All Batch 4 variables are optional or backward-compatible.
4. Then run §7.

---

## 4. Database migration safety

**Is a migration applied?** In the Supabase SQL editor for the correct project (check the project ref in the URL):

```sql
select version, name from supabase_migrations.schema_migrations order by version desc limit 20;
```

Confirm the object itself exists too. For example, the Batch 2 consent column:

```sql
select count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'leads' and column_name = 'sms_consent';
```

**Rules:**

- Pending files in `supabase/pending/` are applied by a person, to one named project, one at a time, with the result read back. Never apply to Production from a script, a test, or the wrong project ref.
- Every pending file has a `_rollback.sql`. Rollbacks usually contain `DROP`: run them by hand, and only after the app that needs the object has been rolled back.
- **Do not roll back an additive migration just because the app was rolled back.** Older code ignores new columns and functions. Dropping a column the current code reads breaks it.

---

## 5. Stopping outbound automation safely

Use the narrowest switch that stops the problem. Each one is reversible, and none of them deletes data.

| Scope | How | Effect |
|---|---|---|
| One automation, one organization | Automations page → turn the automation off | Its sends are blocked at the outbound gate (`automation_disabled`) |
| One organization, everything | Settings → Automation mode → **Switch to Test**, or Agency Command Center → pause the organization (`set_organization_automation_paused`) | The gate refuses every automated customer message for that organization (`organization_not_live` / `organization_automation_paused`). Inbound messages are still recorded. |
| All scheduled automation, all organizations | Supabase SQL: `update cron.job set active = false where jobname like 'trackpr_%';` | Stops every pg_cron tick: reminders, follow-ups, health, sync. The watchdog then reports the scheduler as degraded, which is expected. Undo with `active = true`. |
| Event-driven AI replies | Pause the affected organizations (row above). The n8n workflow may be deactivated only as an authorized Batch 5 action. | n8n drafts that still arrive are blocked at the gate. |

Never remove Vault secrets, rotate `CRON_SECRET`, or change Twilio webhooks to stop automation. Those are slower to undo and produce confusing failure modes.

Staff sends from the inbox are manual and are not affected by these switches. A contact's STOP (`sms_opt_out`) always applies.

---

## 6. When the app and database versions don't match

- **New database, old app** (normal during a release, and after an app rollback): safe. The older code ignores additive objects. Keep it this way until the new app is healthy again.
- **New app, old database** (a migration was skipped): the new code fails closed where it reads a missing object. Batch 2 example: without `leads.sms_consent`, the outbound gate refuses lead-scoped automated sends and the public capture route's lead insert fails.
- **What to do:** either apply the missing pending migration (§4) or roll the app back (§3). Do **not** hand-edit code or the database to bridge the gap.

---

## 7. Checking health (after a release, a rollback, or recovery)

1. **Liveness:** `GET https://<canonical>/api/health` returns `200` with `"checks":{"app":"ok","database":"ok","scheduler":"ok"}`. A `503` says which check failed.
2. **Scheduler (Supabase SQL):**

   ```sql
   select jobname, schedule, active from cron.job where jobname like 'trackpr_%' order by jobname;
   select j.jobname, d.status, d.start_time, d.end_time
     from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname like 'trackpr_%' order by d.start_time desc limit 20;
   select checked_at, stuck_count from automation_health_check_runs order by checked_at desc limit 5;
   ```

   - The jobs are `active`, recent runs `succeeded`, and the latest heartbeat is under 45 minutes old.
   - No new heartbeat while the jobs do run means a health-tick phase is failing (step 4 below).
3. **Watchdog:** in Vercel → Cron Jobs, `/api/automation/scheduler-watchdog` ran today. To test it now, call it with the cron bearer from a trusted machine. Never paste the secret into chat or a ticket.
4. **Ops alerts:** search the Vercel logs for `trackpr_ops_alert`. Common codes:
   - `health_tick_phase_failed` (field `phase` says which)
   - `health_heartbeat_write_failed`
   - `scheduler_degraded`, `scheduler_heartbeat_unreadable`, `scheduler_watchdog_failed`
   - `cron_secret_missing`
   - `stripe_event_mode_mismatch`
5. **Contractor-facing incidents:** the Agency Command Center lists open `automation_incidents` (stuck or failed executions, degraded automations).

---

## 8. What must NOT be rolled back on its own

- **Database migrations,** independently of the app (§4).
- **The n8n workflow,** independently of the app's callback contract. Roll n8n back only to a version whose callback payload the deployed app accepts.
- **Twilio number webhooks:** they point at the canonical domain, which an app rollback does not change. Leave them alone.
- **Stripe keys, webhook endpoints or webhook secrets:** never rotated or swapped as a rollback step. A wrong-mode secret is refused by the guard; it does not need a rollback.
- **Vault secrets** (`trackpr_base_url`, `trackpr_cron_secret`) and `CRON_SECRET`: they must stay equal to each other.
- **Organizations' automation mode or pause flags:** never flipped en masse as a "rollback". Use §5 deliberately and record which organizations you changed.

---

## 9. n8n rollback (Batch 5)

- Before changing the Production workflow `KxH5Fby3XgJVP6Kj`, record its current version. Roll back with n8n's own version history (restore the recorded version), then publish.
- The callback URL in the workflow must be Production's canonical origin + `/api/automation/n8n-callback`, signed with `N8N_WEBHOOK_SECRET`. Changing the canonical domain means updating it here too, as an authorized change.
- TEST n8n workflows are separate. Never point a TEST workflow at Production, or the reverse.

## 10. Twilio and Stripe safety

**Twilio:**
- An app rollback does not touch numbers, A2P registration or webhooks.
- A recipient who opted out at the carrier (error 21610) is stored as opted out and never retried.
- To stop texting, use §5. Do not unassign numbers.

**Stripe:**
- Production must run live keys, and Preview/TEST must run test keys. The guards refuse every other combination unless the explicit Production rehearsal opt-in is set.
- Before Batch 5, confirm in the Stripe dashboard (live mode) that each webhook endpoint points at the canonical domain, and that its signing secret is the one in the Production variables.
- After a rollback, check webhook deliveries in Stripe and re-send any event that failed during the incident. Billing activation and payment recording are idempotent per event.

---

## 11. Verification checklist after any recovery

- [ ] `GET /api/health` → 200, all three checks `ok`
- [ ] Latest `automation_health_check_runs.checked_at` is under 45 minutes old; `trackpr_*` jobs are active and succeeding
- [ ] No new `trackpr_ops_alert` lines in the last 30 minutes, except ones you expected
- [ ] One organization's Today, People and Inbox load for an owner
- [ ] An inbound test SMS to a TEST-mode organization is recorded, and no automated send leaves while that organization is in Test
- [ ] A live organization's next scheduled automation runs on the next tick (check its execution on the Automations page)
- [ ] Stripe: the most recent webhook deliveries succeeded (dashboard), with no `stripe_event_mode_mismatch`
- [ ] Twilio: delivery-status callbacks are arriving (messages move from `queued` to `sent`/`delivered`)
- [ ] Any automation switched off or organization paused during the incident is restored, or deliberately left off with a note
- [ ] The incident, the rollback target and the timestamps are recorded
