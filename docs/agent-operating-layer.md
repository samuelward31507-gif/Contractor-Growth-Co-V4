# Agent Operating Layer — Phase 1

Trackpr's internal intelligence layer: one Chief of Staff in front of six specialist agents. Read and recommend only. Nothing in this layer sends, dispatches, retries, deploys or changes anything.

```
operator
  └─ Chief of Staff            lib/agents/agents/chief-of-staff.ts
       ├─ QA / Health           lib/agents/agents/qa-health.ts
       ├─ Sales                 lib/agents/agents/sales.ts
       ├─ Trackpr Intelligence  lib/agents/agents/trackpr-intelligence.ts
       ├─ Engineering           lib/agents/agents/engineering.ts
       ├─ Market Intelligence   lib/agents/agents/market-intelligence.ts   (interface only)
       └─ Prospecting           lib/agents/agents/prospecting.ts           (interface only)
```

## Where it fits

The layer adds no new data access. It reads through functions that already exist, using the request's own RLS-scoped Supabase client:

| Agent | Reads (existing code) |
|---|---|
| Sales | `assembleDecisions` over `getDashboardSqlData`, `getPrioritizedOpportunities` and `getDecisionContext` (exactly what Today renders) |
| Trackpr Intelligence | `getBusinessMetricsSnapshot` (last 30 days, in the organization's timezone) |
| QA / Health | `getOrganizationHealth`, `listIncidents` (open and acknowledged), `getAutomationMode`, and Today's calendar exception |
| Engineering | the same incidents and health summary, plus a static playbook of real repository paths |
| Market / Prospecting | operator-supplied notes. No source is connected in Phase 1, and nothing is fetched or scraped. |
| Chief of Staff | the six validated `AgentResult`s, and nothing else |

The flow is `lib/agents/load.ts` (reads) → `lib/agents/sources.ts` (narrow projections: no phone numbers, tokens, message bodies or incident metadata) → `lib/agents/operating-layer.ts`. The six specialists run in parallel under one trace id, then the Chief of Staff runs.

## Contract (`lib/agents/contract.ts`)

An agent returns an `AgentOutput`, never prose. It contains:

- `status`
- `summary`
- `findings[]`, each with `id`, `kind` (risk / opportunity / status), `basis` (**fact** / **inference**), `severity` (critical / high / medium / low / info), `confidence` (high / medium / low), `category`, `title`, `detail`, `evidence[]`, an in-app `href`, and https `sources[]`
- `recommendations[]`, each with `actionKind`, `autonomy`, `requiresApproval`, `priority`, `confidence`, `href` and `relatedFindingIds`
- scalar `metadata`

The runtime (`lib/agents/runtime.ts`) wraps the output into an `AgentResult` with these fields:

- `agent`, `runId`, `traceId`, `status`
- `priority` (the highest severity), `confidence` (the lowest), `requiresApproval`
- `dataSources`, `error`, `startedAt`, `createdAt`, `durationMs`

The runtime also guarantees the following:

- **No database handle for agents.** An analyzer receives only its typed input and the clock.
- **No guessing on failed reads.** A failed read produces a `failed` result with a fixed, safe reason.
- **Failures never throw.** Throws, rejections and timeouts (10 s) produce `failed`.
- **Strict validation.** Output that doesn't match the Zod schema is `failed: malformed output` and never reaches the Chief of Staff.
- **Approval enforcement.** The approval model is applied to every recommendation.

## Approval model (`lib/agents/permissions.ts`)

The autonomy levels are `read_only < recommend < requires_approval < autonomous`. Every agent's ceiling is `recommend` in Phase 1.

- These actions are **always** `requires_approval`, whatever the agent claimed: sending customer messages or email, contacting prospects, changing production, deploying code, changing billing, deleting data, changing credentials, changing integrations, and any destructive operation.
- `autonomous` is never granted; a claim of it is downgraded.
- An agent's own approval request is never dropped.
- Approval items appear in the console as "Needs your approval · not executed". The layer has no code path that executes them.

## Chief of Staff

The Chief of Staff is deterministic: there's no model call, so it can't invent anything. Ranking works like this:

1. Severity comes first. A low-confidence item ranks one severity level lower than its label.
2. At equal rank: system reliability (QA, Engineering), then Sales, then Trackpr Intelligence, then platform agents.
3. Then facts before inferences, then higher confidence, then input order.

The briefing contains:

- `mostImportant`, `biggestRisk`, `biggestOpportunity`, `salesPriority`, `systemPriority`
- the sections Needs your attention (3), Opportunities (3), System health (2), Sales (3) and Market (2)
- next actions (3) and approvals (5)
- per-agent status

Today's recommendation is the one sentence it writes itself, composed only from those items. A failed agent shows up as a system-health item, and so does a result that fails validation. Neither is silently dropped.

## Command Center

`/insights/intelligence` is the operator's private Command Center: Agency sidebar → **Intelligence**. It is internal only and is never linked from contractor navigation.

- **Shell.** The route lives in the `app/(agency-console)` route group, whose layout re-exports `app/agency/layout.tsx`. It renders in the Agency shell, never the contractor shell.
- **Access.** `lib/agents/access.ts` decides access server-side, before any agent input is read:
  1. Not signed in: redirect to `/login`.
  2. Signed in but not an agency admin (every contractor): the Agency surfaces' own `UnauthorizedState`, and nothing is loaded. The check is the existing `is_agency_admin()` RPC via `isAgencyAdmin()`, and it fails closed.
  3. Agency admin with no organization membership: redirect to `/onboarding`.
  4. Otherwise access is granted, scoped to the operator's own verified organization through the request's RLS client.
- **Default view: Chief of Staff.** One recommendation, then:
  - **What matters now**: the top 3 items across every agent.
  - **Needs your attention**: operator decisions.
  - **System health**, **Revenue** and **Trackpr is handling**.
  - **Recommended next actions** and **Waiting for your approval**.

  Below the top 3, each item appears in one section only. Every item keeps its basis (Fact or Inference), confidence, evidence and sources, plus an "Open in Trackpr" link and a link to the specialist that produced it.
- **Specialist drill-downs.** `?agent=<sales|trackpr_intelligence|qa_health|engineering|market_intelligence|prospecting>` is validated against the registry and is the page's only URL input. A drill-down shows the agent's purpose, data sources, run, every finding with full evidence, and every recommendation with its approval flag.

## Persistence (optional, off)

`public.agent_runs` holds one row per agent per run, and every row from one briefing shares a `trace_id`. The migration is **pending**: `supabase/pending/agent_runs.sql`, with its rollback and a PGlite validator. Writes happen only when `TRACKPR_AGENT_RUN_PERSISTENCE=on`. They run after the response, through the caller's RLS client, and are best-effort.

## Not in Phase 1

- No market or prospect data source is connected.
- No model-written narrative.
- No scheduling.
- No acting on approvals.
- Only the operator's own organization is covered; there's no cross-organization view.

## Tests

```
node --import ./lib/automation/test-loader.mjs --test lib/agents/*.test.ts
cd supabase/pending/scratch && npm install && npm run validate:agent-runs
```
