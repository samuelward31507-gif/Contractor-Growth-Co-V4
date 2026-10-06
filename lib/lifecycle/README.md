# Canonical lifecycle model (P0-B B1)

One answer to: **where is this customer in the revenue lifecycle right now?**

| File | What |
|---|---|
| `stages.ts` | The stage vocabulary (`LIFECYCLE_STAGES`, in precedence order) and a definition per stage. |
| `statuses.ts` | The entity status sets the model reads, each copied from the definition the codebase already uses (pinned by `statuses.test.ts`). |
| `snapshot.ts` | `LifecycleSnapshot`: the typed facts for one contact, plus `asOf` and the organization's lifecycle policy. |
| `snapshot-loader.ts` | `loadLifecycleSnapshot(supabase, organizationId, contactId, { asOf })`: read-only; scoped by organization and contact; returns `failed` rather than an empty snapshot. |
| `derive.ts` | `deriveLifecycleStage(snapshot)`: pure (no DB, no clock, no side effects, independent of row order). |

`lead-backfill.ts` (already here) is unrelated: it is a one-off data tool.

## What it is, and what it is not

- **It is** a customer-level *position*, derived from the existing rows.
- **It is not** an entity status. `leads.status`, appointment, estimate, job and invoice statuses are untouched and remain authoritative for their own records.
- **It is not** an obligation or next action. A4 `followups`, decisions and next-step are separate; the model only gives them a shared lifecycle answer.
- **It does not** read the `opportunities` table to decide anything. Those rows are derived from the same facts and can lag, so they are carried as informational `openOpportunityTypes` only.
- **No persistent state**: no table, no migration.

## Stages and precedence

The order of `LIFECYCLE_STAGES` **is** the precedence policy: the earlier stage wins when several are open. Every open stage is still returned in `activeStages`, and the deciding entity is returned as `primary`. Within a stage the most recent entity is primary, with ties broken by id.

1. **Committed work and money in flight**
   - `job_active`: a job is scheduled or in progress.
   - `won`: an estimate was accepted (or a lead marked won) with no job yet.
   - `invoicing`: a completed job (after `INVOICING_LIVE_AT`) has a missing, draft, sent or partially paid live invoice.
2. **Active pursuit**, furthest along first
   - `estimate_follow_up`: a sent estimate older than the organization's `followup_1_hours`.
   - `estimate_sent`
   - `estimating`: a draft estimate, or a lead marked `estimate`.
   - `visited`: a completed (or past, never closed-out) visit for an open lead, with nothing quoted after it.
   - `booked`: scheduled/confirmed and not over yet, including in progress, or a lead marked `appointment`.
   - `qualified`
   - `conversing`: the customer replied after the business responded.
   - `responding`: the business responded (sent, delivered or logged outbound), or the lead is marked contacted.
   - `new_lead`
3. **Open asks on finished work**: `review`, then `referral` (requested or responded).
4. **Settled** (nothing open)
   - `dormant`: a past customer whose last completed job is at least the organization's `inactivity_days` old (the same `>=` rule as customer reactivation).
   - `paid`: the most recent completed job is paid.
   - `customer`: a past customer otherwise, e.g. a job completed before invoicing went live.
   - `lost`: never served, with a lost lead or a declined or expired estimate.
   - `no_activity`.

### How the conflict rules were chosen

They follow existing code.

- **Active job first:** the People badge (`lib/customers/lifecycle-stage.ts`) puts active jobs first. It also states the principle "the more current signal wins".
- **Committed revenue above pursuit:** Today's priority tiers (`lib/opportunities/intelligence.ts`) rank committed revenue above active pursuit, and active pursuit above growth asks.
- **Booked and visited:** these use the same rules as Today's opportunity detectors (`lib/opportunities/lifecycle.ts`), including the M2/M4/M5 visit association and clearing rules.
- **Invoicing:** follows `lib/people/next-step.ts` and `isLegacyCompletedJob`.

Three judgment calls are worth knowing:

- **`won` above `invoicing`.** Both are committed-revenue tier, and the newer committed work is the more current signal.
- **`review`/`referral` below every pursuit stage.** This follows the revenue tiers and *differs from the People badge*, which ranks `review_requested` above `estimate_sent`. The badge is unchanged.
- **An open lead or draft estimate older than the latest completed job is stale, not active.** It is reported in `signals` as `stale_open_lead` / `stale_draft_estimate`. This is the A3 "superseded" idea: newer completed work overtook it.

## Repeat Service / Reactivation / New Opportunity

These describe how the **current open cycle** relates to the customer's history. They are not stages.

`origin` takes one of four values; the cycle starts at its earliest open item, and an ask counts from its job's creation:

- `first_purchase`: no prior completed job and no earlier loss.
- `repeat_service`: came back while still a recent customer, meaning the last prior completed job was less than `inactivity_days` before the cycle started.
- `reactivation`: came back after going dormant.
- `returning_lead`: never served; an earlier lead was lost or an earlier estimate declined or expired.

`newOpportunity` is `true` for every origin except `first_purchase`.

With nothing open, the settled stage tells the two apart: `customer` / `paid` (repeat-service territory) vs `dormant` (reactivation territory). `history.repeatCustomer` (2 or more completed jobs) is the codebase's existing repeat-customer definition.

## Known limitations

- **No "due for repeat service".** There is no service-type or service-interval data anywhere in the schema (the same finding as `lib/opportunities/detect.ts`), so nothing claims a customer is due.
- **No separate "Identify" stage.** No data distinguishes "identified" from "new lead".
- **Leads marked `appointment` or `estimate`** are honored as a floor (`booked` / `estimating`) even without rows. Real rows take precedence because they rank at or above that floor.
- **Phone calls create no messages,** so a call does not move a lead to `responding` or `conversing` unless someone marks it contacted.
- **Messages:** the loader reads the latest 200.
- **Won leads:** a lead marked `won` with no job stays `won` (e.g. gym membership conversion).
- **Organization policy:** `asOf` and the policy (dormancy days, estimate follow-up hours) are part of the snapshot, so the result is reproducible, but it changes if the organization changes its automation config.

## What B2+ will consume (not wired in B1)

Nothing outside `lib/lifecycle` imports this model yet; `statuses.test.ts` enforces that. The intended consumers are:

- the automation dispatcher, through a "customer advanced since anchor" check from `activeStages` / `primary`;
- transition writers;
- the unified next-action resolver and Today, through `stage` / `primary` / `signals`;
- People and Conversations;
- AI qualification;
- the follow-up engine;
- revenue intelligence;
- customer reactivation, through `dormant` / `origin`.
