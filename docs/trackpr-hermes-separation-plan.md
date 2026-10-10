# TrackPR vs. Hermes — Ownership Boundary and Separation Plan

Status: **planning document only.** Nothing described here has been implemented,
and no phase below may start without its own explicit approval.

- Date: 2026-10-10
- Repository checkpoint when written: branch `feature/quote-redesign`, commit `91c2949`
- Scope of evidence: this repository only. Hermes (`~/Downloads/cinder-webwork/`)
  lives on the founder's machine and was **not inspected**; nothing here assumes
  what Hermes already does.
- Production was **not** inspected (Production inventory is not authorized).
  Database facts come from repository SQL files and from a read-only TEST
  check on 2026-10-10 (Supabase project `trackpr-stripe-test`).

Legend used throughout: **[V]** verified in this repository (path cited);
**[T]** verified on TEST only; **[U]** unverified / needs verification;
**[D]** approved decision.

---

## 0. Approved decisions (authoritative for this plan)

| # | Decision | Status |
|---|---|---|
| D1 | Document the TrackPR vs. Hermes ownership boundary without silently replacing the TrackPR Master Product Roadmap | Approved |
| D2 | Freeze new Founder-workspace (`/founder/*`) feature development; do not delete, migrate or alter existing functionality | Approved |
| D3 | Production inventory | **Not authorized** |
| D4 | Hermes owns internal delivery project management; TrackPR keeps client readiness checks and launch-gating logic | Approved |
| D5 | Expansion is split: TrackPR owns evidence-based signals and client operational facts; Hermes owns internal follow-up, prioritization and agency sales execution | Approved |
| D6 | AI/SMS usage and cost stay internal (no client-facing usage/cost features) | Approved |
| D7 | Retiring Founder routes and adding redirects is deferred until Hermes has verified functional parity and authentication | Approved |

### Roadmap conflict (needs an explicit roadmap decision)

The TrackPR Master Product Roadmap is **not stored in this repository** [V]
(no roadmap/plan file exists; `docs/` holds only `operator-runbook.md` and
`release-rollback-runbook.md`). The Agency OS Master Plan shared in the planning
conversation placed the founder sales pipeline, client handoff, delivery board,
founder finance and the founder daily operating system *inside* TrackPR
(Phases 1–5), with Hermes appearing only as a later integration contract
(Phase 6). This boundary moves most of that ownership to Hermes.

**This document does not override the roadmap.** Until the roadmap owner
records an explicit decision, treat the conflict as open (see §5, R1).

---

## A. Ownership matrix

"Current location" is what the repository contains today. "Intended owner" is
the approved target state, not a change being made now.

### A1. Calendar and scheduling
- **Current:** two unrelated calendars.
  - Client Schedule `/schedule` composes the appointments list and the
    day/week/month calendar (`app/(app)/schedule/page.tsx`). It reads
    `appointments`, `blocked_time` and `calendar_connections`, all filtered by
    `organization_id` (`lib/appointments/queries.ts:89-161`,
    `app/(app)/calendar/actions.ts:95-157`) [V]. Google sync goes through
    `app/api/calendar/oauth/*`, which takes the organization from the session,
    never the query string, and requires an owner/admin
    (`oauth/start/route.ts:19-51`) [V]. RLS uses `is_org_member` /
    `is_org_admin` (`supabase/migrations/20260922040000_calendar_connections.sql:64-74`) [V].
  - Founder calendar `/founder/calendar` reads only `founder_items`
    (`lib/founder/calendar.ts`). It has no external sync [V].
- **Intended owner:** client Schedule → **TrackPR**. Founder calendar → **Hermes**.
- **Stays in TrackPR:** everything client-facing: appointments, blocked time,
  booking, availability, Google Calendar connection, reminders, no-show detection.
- **Hermes will own:** the founder's personal/internal schedule.
- **Dependencies / open questions:**
  - Appointment reminders and no-show detection depend on the client calendar [V].
  - Nothing outside `/founder` depends on the founder calendar [V].
  - Hermes calendar parity is unknown [U].

### A2. Personal tasks, priorities and daily review
- **Current:** `/founder` Home (deterministic briefing), `/founder/tasks`,
  `/founder/review`, daily priorities. Data is in `founder_items`,
  `founder_reviews` and the daily-focus columns on `founder_items`
  (`supabase/pending/founder_command_center.sql`, `founder_daily_focus.sql`).
  Access is the founder allow-list `is_founder()`; everyone else gets a 404
  (`app/founder/layout.tsx`) [V]. The client app has **no** personal task feature [V].
- **Intended owner:** **Hermes**.
- **Stays in TrackPR:** nothing new (D2 freeze). Existing pages remain
  unchanged until D7 is satisfied.
- **Hermes will own:** tasks, priorities, commitments, daily planning and review.
- **Dependencies / open questions:**
  - No scheduled job, webhook or n8n flow reads `founder_*` tables [V].
  - Whether these tables exist in Production, and hold rows, is unknown [U]
    (inventory not authorized).

### A3. Agency area and client management
- **Current:** `/agency` overview (health, onboarding stages, escalations,
  needs-attention) and `/agency/organizations/[id]`. Access is the
  `agency_admins` allow-list plus `is_agency_admin()`
  (`supabase/migrations/20260918182032_agency_command_center_foundation.sql:12-60`) [V].
  Cross-organization reads use the service-role client only *after* the admin
  check, limited to `agency_organizations` (`lib/agency/queries.ts:84-124`) [V].
- **Intended owner:** **TrackPR**, as the source of client operational truth.
  Hermes reads summaries through the controlled integration.
- **Stays in TrackPR:** client registry (`organizations`, `agency_organizations`),
  client health, setup and readiness, client-level operations.
- **Hermes will own:** internal views and prioritization built on the summaries.
- **Dependencies / open questions:**
  - There are two client registries: `agency_organizations` (applied
    migration; TrackPR monitoring) and `agency_clients` (pending SQL;
    commercial/delivery record, optionally linked to an organization)
    (`supabase/pending/agency_client_handoff.sql:44-66`,
    `agency_client_delivery.sql:65`) [V]. Which one Hermes keys on is open (Q4).

### A4. Founder sales / deals pipeline
- **Current:** `/founder/deals`. Data is in `founder_deals` and
  `founder_deal_activities`, written only through SECURITY DEFINER functions
  (`supabase/pending/founder_command_center.sql`, `founder_sales_os.sql`).
  Applied on TEST [T]; Production unknown [U].
- **Intended owner:** **Hermes**.
- **Stays in TrackPR:** nothing new (D2). The existing feature stays until Phase 5.
- **Hermes will own:** prospecting, outreach, pipeline, deal activity, and the
  reasons prospects buy, decline or stall.
- **Dependencies / open questions:**
  - `agency_clients.source_deal_id` and `agency_client_handoffs.deal_id` are
    foreign keys to `founder_deals` (`agency_client_handoff.sql:58,71`) [V].
    This is the hard blocker for moving deals (see R4).

### A5. Client handoffs
- **Current:**
  - Founder side: prepare and cancel from the deal (`founder_prepare_client_handoff`,
    `cancel_client_handoff`).
  - Agency side: `/agency/handoffs`, where an agency admin confirms
    (`agency_confirm_client_handoff`), creating the `agency_clients` row
    (`app/agency/handoffs/actions.ts:45-60`) [V].
  - The schema exists **only in pending SQL** (`supabase/pending/agency_client_handoff.sql`;
    no migration) [V], applied on TEST [T].
- **Intended owner:** **shared through a controlled integration.**
- **Stays in TrackPR:** agency-admin confirmation, its authorization checks,
  and creation of the client record.
- **Hermes will own:** the won-deal side. It submits a controlled handoff
  *request*; TrackPR still requires admin confirmation.
- **Dependencies / open questions:**
  - The request contract (fields, idempotency, authentication) is not designed (Q5).
  - Shared rules currently live in `lib/founder/handoff.ts` and are imported by
    `app/agency/handoffs/*` [V], so they would need a neutral home.

### A6. Delivery board and project management
- **Current:** `/agency/delivery` and `/agency/delivery/[id]`: lifecycle,
  tasks, events, launch gate and readiness. Schema is **pending SQL only**
  (`supabase/pending/agency_client_delivery.sql`) [V]. Readiness checks read
  live signals from the linked organization (`lib/agency/delivery-queries.ts:193-197`) [V].
  `computeOnboardingReadiness` also feeds the agency overview and expansion [V].
- **Intended owner:** project management → **Hermes** (D4). Readiness checks
  and launch-gating logic → **TrackPR** (D4).
- **Stays in TrackPR:** onboarding/readiness computation, launch-gate rules
  (`agency_delivery_gate`, ready-to-launch / approve-launch checks), and the
  organization setup checklist.
- **Hermes will own:** delivery tasks, owners, due dates, workload and internal
  milestones.
- **Dependencies / open questions:**
  - The launch gate and the task board share tables (`agency_client_tasks`,
    `agency_client_launches`) [V]. They must be split before the move (R5).

### A7. Automation monitoring and pause controls
- **Current:**
  - Client: `/automations` (incidents, retry, run/dry-run) and
    `lib/automation-health/*` [V].
  - Agency: health across clients (`lib/agency/health.ts`, a yes/no
    `needsAttention` flag, not a score) and pause via
    `set_organization_automation_paused`, which re-checks admin rights in SQL
    (`supabase/migrations/20260922020000_organization_automation_pause.sql:59-107`) [V].
  - Outbound sends pass through `evaluateOutboundGate`
    (`lib/automation/outbound-gate.ts:146-183, 316-334`) [V].
- **Intended owner:** **TrackPR**. This is never moved.
- **Stays in TrackPR:** execution, monitoring, incidents, retries, pause,
  payment gate, consent, quiet hours, opt-out, HELP/STOP/START.
- **Hermes will own:** read-only awareness (status, reasons, counts).
- **Dependencies / open questions:**
  - Naming hazard: `lib/notifications/founder.ts` (`notifyFounder`) and the
    "founder-facing" kill switch are client-product features that notify the
    client organization's owner. They are **not** part of the Founder
    workspace and must not move [V].

### A8. Expansion opportunities
- **Current:** `/agency/expansion` aggregates the client Opportunity Engine
  (`lib/opportunities/detect.ts`) and onboarding readiness. It maps each
  opportunity type to a service with graded confidence and no invented dollar
  amounts (`lib/agency/expansion.ts:1-60`) [V].
- **Intended owner:** **split** (D5).
- **Stays in TrackPR:** signal detection, evidence, client-specific facts, the
  type → service mapping.
- **Hermes will own:** follow-up, prioritization and sales execution on those
  signals.
- **Dependencies / open questions:** Today (client) and Expansion (agency)
  share the same opportunity source [V].

### A9. Revenue, AI/SMS usage and cost reporting
- **Current:**
  - `revenue_events` is written by the Stripe webhook
    (`app/api/webhooks/stripe/route.ts:50,389`) [V].
  - `ai_cost_events`, `rate_cards` and `sms_cost_events` are readable only via
    `is_agency_admin()` (migrations `20260927000000`, `20260928000000`) [V].
  - Reports: `/agency/revenue`, `/agency/costs`, `/agency/usage` [V].
  - Clients see no cost data [V].
  - Not costed: voice, n8n, hosting, email
    (`app/agency/costs/_components/unsupported-providers.tsx:5-9`) [V].
- **Intended owner:** records → **TrackPR**. Totals → shared via the integration.
- **Stays in TrackPR:** all event records and per-client reporting, internal only (D6).
- **Hermes will own:** agency-level views built from totals.
- **Dependencies / open questions:**
  - AI cost is only recorded from `lib/bi/insights.ts` [V].
  - Whether n8n AI usage is costed anywhere is unknown [U].

### A10. Finance, cash, burn and runway
- **Current:** `/founder/finance` and its records (expenses, recurring costs,
  income, cash balances, burn, runway). Schema is pending SQL only
  (`supabase/pending/founder_finance.sql`) [V], applied on TEST [T]. Its
  aggregate functions read `revenue_events` (`founder_finance.sql:977,1034`)
  and `agency_clients` (`:1056-1067`). Cost estimates reuse the agency cost
  functions and require the user to also be an agency admin
  (`lib/founder/finance-estimates.ts:2,25`) [V].
- **Intended owner:** **Hermes**.
- **Stays in TrackPR:** nothing new (D2). Revenue and cost records stay as the
  source.
- **Hermes will own:** expenses, cash, burn, runway, agency operating metrics.
- **Dependencies / open questions:**
  - Hermes needs revenue and contracted-MRR totals from TrackPR (Q6).
  - Founder MRR entries (`/founder/metrics`) overlap with Finance contracted MRR [V].

### A11. Authentication, authorization and customer-data boundaries
- **Current:** three separate access models [V]:
  - Client organization membership with RLS on every product table.
  - Agency admin (`agency_admins` + `is_agency_admin()`).
  - Founder allow-list (`founder_users` + `is_founder()`, pending SQL).

  The founder and agency layouts render each other's navigation group as a
  convenience; each route still enforces its own check
  (`app/agency/layout.tsx:53`, `app/founder/layout.tsx`) [V].
- **Intended owner:**
  - TrackPR keeps all three models while the features exist.
  - Hermes authenticates its own users.
  - Cross-system access uses a dedicated least-privilege server credential only.
- **Stays in TrackPR:** RLS, payment gate, pause, outbound safety checks,
  webhook signatures, `CRON_SECRET`, Vault.
- **Hermes will own:** its own identity and authorization.
- **Dependencies / open questions:**
  - Hermes authentication model is unknown [U] (R1, Q3).
  - End-customer personal data must never cross the boundary (§B, R9).

---

## B. Dependency and risk register

| ID | Risk / dependency | Evidence | Status | Mitigation / required before proceeding |
|---|---|---|---|---|
| R1 | Roadmap conflict: the Master Plan put the founder sales pipeline, handoff, delivery, finance and daily OS in TrackPR | §0 | Open | Roadmap owner records an explicit decision. No phase beyond Phase 1 starts until then. |
| R2 | Hermes capability and authentication parity is unknown | Hermes not in this repo | [U] | Phase 3 parity checklist, signed off by the founder, before any retirement |
| R3 | Founder and agency-client schemas exist only as hand-run SQL. File headers still say "PENDING - not applied anywhere" (`supabase/pending/founder_command_center.sql:4`), yet they are applied on TEST [T]. `supabase/pending/README.md` has no section for them [V]. | Repo + TEST | Partly [U] | Treat TEST and Production as possibly different. Any Production step needs its own authorization. Headers are documentation drift; correct them only with approval. |
| R4 | `agency_clients.source_deal_id` → `founder_deals` and `agency_client_handoffs.deal_id` → `founder_deals` | `agency_client_handoff.sql:58,71` [V] | Blocking for Phase 5 | Design a replacement reference (an opaque external deal reference from Hermes). The migration needs a rollback and TEST validation. Never drop `founder_deals` while foreign keys point at it. |
| R5 | Delivery board and launch gate share tables and functions in `agency_client_delivery.sql` | [V] | Blocking for Phase 6 | Split readiness and launch-gate rules (stay in TrackPR) from task/workload tracking (moves to Hermes) before any move |
| R6 | `/api/agency/overview` authorizes a **logged-in session**, then uses the service role (`app/api/agency/overview/route.ts`) [V]. It returns organization names, per-organization metrics and health. No UI uses it [V]. | [V] | Not suitable as-is | Do not expose it to Hermes. Phase 2 designs a separate, totals-only endpoint with a dedicated server credential. |
| R7 | Moving routes breaks deep links, navigation and tests | `lib/ui/operator-shell/nav.ts:51-75`, `nav.test.ts:9-27`, founder structural tests, `app/agency/layout.tsx:53`, deal-to-calendar links (`/founder/calendar?item=`) [V] | Deferred (D7) | Redirects plus test updates in the same change, Preview first |
| R8 | Data export, retention and ownership: no export path exists. Founder finance records are void-only (no hard delete) by design. | `founder_finance.sql` [V] | Open | Export before any retirement. Keep tables through a retention window. Drop only after separate approval (Phase 7). |
| R9 | Privacy: cross-system access could leak end-customer personal data (leads, contacts, messages, phone numbers) | Product tables hold this [V] | Design constraint | Totals-only allow-listed fields; tests asserting no personal-data fields; no service-role key outside TrackPR |
| R10 | Security: a new inbound credential widens the attack surface | — | Design constraint | Dedicated credential, constant-time comparison (pattern: `lib/automation/cron-auth.ts`), rate limit, request logging, revocation, least privilege |
| R11 | Name collisions: "founder" in `lib/notifications/founder.ts` and the automation pause means client owner / agency. `app/(cinder)` is the TrackPR marketing site, not Hermes. | [V] | Known | Exclude these from every separation phase |
| R12 | Handoff and delivery schemas absent from a database cause empty or "not enabled" states (`lib/agency/handoffs.ts:82-83`, `delivery-queries.ts:124-169`) [V] | [V] | Known | Not a failure mode, but Production status is [U] |
| R13 | Founder finance cost estimates require dual roles (founder + agency admin) [V] | `finance-estimates.ts` | Known | Phase 6 replaces this with integration totals |

---

## C. Phased plan (each phase needs separate approval)

No phase is in progress. Each phase must be reversible and proven on TEST and
Preview before any Production consideration. Production steps need their own
authorization (D3).

### Phase 1 — Document and freeze
- **Prerequisites:** D1, D2.
- **Permitted:** this document. Freeze new `/founder/*` features.
- **Acceptance:** document reviewed. No new founder-workspace work is accepted.
- **Rollback:** revert the documentation commit.
- **Evidence to proceed:** roadmap decision on R1.
- **Status:** this document is the Phase 1 deliverable.

### Phase 2 — Design and test a read-only TrackPR → Hermes integration
- **Prerequisites:** R1 resolved. Hermes hosting and credential model chosen (Q3).
  Summary field list approved (Q2).
- **Permitted after approval:**
  - A new server-to-server endpoint in TrackPR.
  - Least-privilege credential verification (constant time).
  - Restriction to approved clients (`agency_organizations`).
  - Totals-only, allow-listed response fields.
  - Rate limiting, structured logging, automated tests.
- **Not permitted:** any service-role or database credential in Hermes;
  writes; personal-data fields; changes to existing endpoints, RLS or safeguards.
- **Acceptance (all automated):**
  - Missing, wrong or revoked credential → refused.
  - Unapproved client → excluded.
  - Response fields match the allow-list exactly; no personal-data fields.
  - Rate limit enforced.
  - Partial source failure is reported as unavailable, never as zero.
- **Rollback:** additive. Remove the route and revoke the credential.
- **Evidence to proceed:** tests green; Preview check with a TEST credential;
  security review of the diff.

### Phase 3 — Verify Hermes parity (tasks, calendar, priorities, daily review)
- **Prerequisites:** Hermes is accessible for review. A parity checklist is agreed.
- **Permitted:** a parity checklist and its verification in Hermes. No TrackPR
  code changes.
- **Acceptance:** each current capability is demonstrated in Hermes and signed
  off by the founder: task CRUD, item kinds, due/overdue, calendar views,
  three daily priorities, daily review, deterministic briefing rules. Hermes
  authentication works.
- **Rollback:** not applicable (TrackPR unchanged).
- **Evidence to proceed:** the signed checklist.

### Phase 4 — Plan Founder workspace route retirement
- **Prerequisites:** Phase 3 signed off (D7). Export format agreed. Export
  rehearsed on TEST.
- **Permitted after approval:**
  - Remove the founder personal pages from navigation.
  - Add redirects in `next.config.ts` (temporary first).
  - Update `nav.test.ts`, the founder structural tests and redirect tests.
  - Keep `/founder/deals` and `/founder/finance` until Phases 5–6.
- **Not permitted:** dropping tables, deleting data, editing SQL.
- **Acceptance:**
  - Redirect tests pass.
  - No broken links: deep links such as `?item=` resolve or redirect.
  - The agency layout no longer renders removed entries.
  - Full suite, typecheck, lint and build are green.
  - Preview verified.
- **Rollback:** revert the single commit. Data is untouched.
- **Evidence to proceed:** Preview walkthrough plus a confirmed export.

### Phase 5 — Sales pipeline and client-handoff ownership
- **Prerequisites:** R4 design approved. Handoff request contract (Q5) approved.
  Hermes pipeline parity verified.
- **Permitted after approval:**
  - Migration replacing the `founder_deals` foreign keys with an external
    deal reference, with a rollback script validated on TEST.
  - An inbound handoff-request endpoint (authenticated, idempotent). Agency-admin
    confirmation in TrackPR stays mandatory.
  - Move shared handoff rules out of `lib/founder/handoff.ts`.
- **Not permitted:** auto-confirming handoffs; creating organizations from Hermes.
- **Acceptance:**
  - Existing handoffs keep their history.
  - Confirmation still requires an agency admin.
  - Duplicate requests are idempotent.
  - Rollback SQL validated on TEST.
- **Rollback:** migration rollback script plus a commit revert. Founder tables
  are retained.
- **Evidence to proceed:** TEST validation and the validator output.

### Phase 6 — Delivery board and agency finance ownership
- **Prerequisites:** R5 split design approved. Phase 2 integration live on
  TEST. Hermes finance parity verified.
- **Permitted after approval:**
  - Separate the readiness and launch-gate rules (stay in TrackPR) from task
    tracking (moves to Hermes).
  - Hermes consumes revenue and contracted-MRR totals through the integration.
  - Retire `/founder/finance` UI only after parity.
- **Acceptance:**
  - Launch gate behaviour unchanged (existing tests plus new ones).
  - Finance figures in Hermes reconcile with TrackPR totals.
  - No cost data reaches clients (D6).
- **Rollback:** commit revert. Tables are retained.
- **Evidence to proceed:** reconciliation report on TEST.

### Phase 7 — Legacy data retention and cleanup
- **Prerequisites:** separate explicit approval. Retention window elapsed.
  Exports verified restorable.
- **Permitted after approval:** run the existing `*_rollback.sql` files for
  retired founder/agency-delivery objects, TEST first.
- **Acceptance:** exports restorable. No foreign keys reference dropped
  objects. All tests green.
- **Rollback:** restore from export. The re-apply scripts exist in
  `supabase/pending/*.sql`.

---

## D. Verification and approval gates (for future phases; none run for this document)

| Gate | Check | Where (existing pattern) | Phase |
|---|---|---|---|
| G1 Authentication | Missing, malformed, wrong or revoked credential → 401/403; constant-time comparison | `lib/automation/cron-auth.ts` pattern; new route test | 2, 5 |
| G2 Authorization | Unapproved client excluded; non-admin session denied on `/agency/*`; non-founder 404 on `/founder/*` | `lib/supabase/middleware.behavior.test.ts`, `app/founder/founder-access.structural.test.ts`, `app/agency/agency-overview.structural.test.ts` | 2, 4, 5 |
| G3 Totals only | Response keys equal the approved allow-list | New unit test | 2 |
| G4 No personal data | Response contains no lead/contact/message/phone/email fields or values; fuzz with seeded TEST-shaped fixtures (no real data) | New unit test | 2 |
| G5 Failure handling | A failing source → `unavailable` with reason; never zero; no partial secret or stack in output | New unit test | 2, 6 |
| G6 Navigation | Nav groups match the approved menus | `lib/ui/operator-shell/nav.test.ts`, `app/(app)/_components/nav-items.test.ts` | 4 |
| G7 Redirects | Every retired path redirects to the approved target | `next.config.test.ts` | 4 |
| G8 Safeguards unchanged | Outbound safety checks, pause, payment gate, webhook signatures and cron auth suites pass unmodified | `lib/automation/*`, `lib/messaging/*`, `lib/payments/*`, `app/api/*` tests | All |
| G9 Database changes | Validator plus rollback on TEST; no Production action | `supabase/pending/scratch/validate-*.mjs` pattern | 5, 6, 7 |
| G10 Release | Full suite, `tsc`, ESLint, `next build`; Preview check; diff review; protected files untouched | Repo scripts | All |

---

## E. Open questions requiring decisions

- Q1. Roadmap decision on R1 (record it in the roadmap itself).
- Q2. Exact field list for the Hermes summary (candidates: needs-attention flag
  and reasons, open incident count, automation-paused and payment status,
  onboarding readiness, AI/SMS cost totals, revenue totals, expansion
  opportunity types and counts).
- Q3. Hermes hosting, its authentication, and how TrackPR issues and revokes
  its credential.
- Q4. Which registry Hermes keys on: `organizations` / `agency_organizations`
  (applied) or `agency_clients` (pending SQL).
- Q5. Handoff request contract: fields, idempotency key, and how TrackPR
  reports the confirmation outcome back.
- Q6. Whether contracted MRR (`agency_clients` fees) is a TrackPR total or a
  Hermes-owned figure.
- Q7. Redirect targets for retired `/founder/*` routes (deferred by D7).
- Q8. Whether to correct the outdated "not applied anywhere" headers in the
  pending founder SQL files (documentation-only; needs approval).
