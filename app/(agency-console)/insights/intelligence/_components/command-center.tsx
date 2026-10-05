import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Lock } from "lucide-react";
import type { AgentStatusLine, BriefingAction, BriefingItem, ChiefOfStaffBriefing } from "@/lib/agents/agents/chief-of-staff";
import type { AgentId, AgentResult, Confidence, Evidence, FindingBasis, Recommendation, Severity, SourceRef } from "@/lib/agents/contract";
import { AGENT_REGISTRY, SPECIALIST_AGENT_IDS, type SpecialistAgentId } from "@/lib/agents/registry";
import { StatusDot, type StatusDotTone } from "@/lib/ui/status-dot";
import { cardClass } from "@/lib/ui/surface";
import { metaClass } from "@/lib/ui/typography";

/**
 * The internal Command Center - presentation only. Every line arrives from
 * lib/agents; nothing here reads data or executes anything. Links open the
 * existing Trackpr screens (where every existing gate still applies) or a
 * specialist's drill-down. Approval items are listed, never actionable.
 */

export const COMMAND_CENTER_PATH = "/insights/intelligence";
export const specialistHref = (agent: SpecialistAgentId) => `${COMMAND_CENTER_PATH}?agent=${agent}`;
const isSpecialist = (agent: AgentId): agent is SpecialistAgentId => (SPECIALIST_AGENT_IDS as readonly string[]).includes(agent);

const TONE_BY_SEVERITY: Record<Severity, StatusDotTone> = { critical: "critical", high: "critical", medium: "attention", low: "neutral", info: "healthy" };
const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
const SEVERITY_TEXT: Record<Severity, string> = { critical: "text-danger-text", high: "text-danger-text", medium: "text-warning-text", low: "text-ink-3", info: "text-ink-3" };
const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

// --- Small pieces -----------------------------------------------------------

function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "inference" | "approval" }) {
  const toneClass = tone === "inference" ? "border-info-border bg-info-muted text-info-text" : tone === "approval" ? "border-warning-border bg-warning-muted text-warning-text" : "border-line bg-inset text-ink-3";
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${toneClass}`}>{children}</span>;
}

function SeverityMark({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${SEVERITY_TEXT[severity]}`}>
      <StatusDot tone={TONE_BY_SEVERITY[severity]} />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

function BasisTag({ basis }: { basis: FindingBasis }) {
  return <Tag tone={basis === "inference" ? "inference" : "neutral"}>{basis === "fact" ? "Fact" : "Inference"}</Tag>;
}

function AgentTag({ agent }: { agent: AgentId }) {
  const name = AGENT_REGISTRY[agent].name;
  return isSpecialist(agent) ? (
    <Link href={specialistHref(agent)} className="rounded-md border border-line bg-inset px-1.5 py-0.5 text-[11px] font-medium leading-none text-ink-3 transition-colors hover:border-line-strong hover:text-ink">
      {name}
    </Link>
  ) : (
    <Tag>{name}</Tag>
  );
}

function EvidenceList({ evidence, sources, limit }: { evidence: Evidence[]; sources: SourceRef[]; limit?: number }) {
  const shown = limit === undefined ? evidence : evidence.slice(0, limit);
  if (shown.length === 0 && sources.length === 0) return null;
  return (
    <dl className="mt-2 grid gap-x-3 gap-y-0.5 text-[12px] leading-snug sm:grid-cols-[minmax(0,10rem)_1fr]">
      {shown.map((e, i) => (
        <div key={`${e.label}-${i}`} className="contents">
          <dt className="truncate text-ink-4">{e.label}</dt>
          <dd className="min-w-0 break-words text-ink-2">{e.value}</dd>
        </div>
      ))}
      {sources.map((source) => (
        <div key={source.url} className="contents">
          <dt className="text-ink-4">Source</dt>
          <dd className="min-w-0 break-words">
            <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="text-ink-2 underline underline-offset-2 hover:text-ink">
              {source.title}
            </a>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function OpenLink({ href }: { href?: string }) {
  if (!href) return null;
  return (
    <Link href={href} className="inline-flex items-center gap-0.5 text-[12px] font-medium text-ink-3 transition-colors hover:text-ink">
      Open in Trackpr
      <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
    </Link>
  );
}

type ItemLike = { key: string; agent: AgentId; severity: Severity; confidence: Confidence; basis: FindingBasis; title: string; detail: string; evidence: Evidence[]; sources: SourceRef[]; href?: string };

function FindingRow({ item, evidenceLimit = 3, showAgent = true }: { item: ItemLike; evidenceLimit?: number; showAgent?: boolean }) {
  return (
    <li className="py-3.5 first:pt-1 last:pb-1">
      <div className="flex items-center justify-between gap-3">
        <SeverityMark severity={item.severity} />
        <OpenLink href={item.href} />
      </div>
      <p className="mt-1 text-[14px] font-medium leading-snug text-ink">{item.title}</p>
      <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{item.detail}</p>
      <EvidenceList evidence={item.evidence} sources={item.sources} limit={evidenceLimit} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <BasisTag basis={item.basis} />
        {item.confidence !== "high" ? <Tag>{CONFIDENCE_LABEL[item.confidence]}</Tag> : null}
        {showAgent ? <AgentTag agent={item.agent} /> : null}
      </div>
    </li>
  );
}

type ActionLike = { key: string; agent: AgentId; title: string; detail: string; priority: Severity; confidence: Confidence; requiresApproval: boolean; href?: string };

function ActionRow({ action, showAgent = true }: { action: ActionLike; showAgent?: boolean }) {
  return (
    <li className="flex gap-3 py-3 first:pt-1 last:pb-1">
      {action.requiresApproval ? <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning-text" /> : <StatusDot tone={TONE_BY_SEVERITY[action.priority]} className="mt-[7px]" />}
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium leading-snug text-ink">
          {action.href && !action.requiresApproval ? (
            <Link href={action.href} className="underline-offset-2 hover:underline">
              {action.title}
            </Link>
          ) : (
            action.title
          )}
        </p>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{action.detail}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Tag>Recommendation</Tag>
          {action.requiresApproval ? <Tag tone="approval">Needs your approval · not executed</Tag> : null}
          {action.confidence !== "high" ? <Tag>{CONFIDENCE_LABEL[action.confidence]}</Tag> : null}
          {showAgent ? <AgentTag agent={action.agent} /> : null}
        </div>
      </div>
    </li>
  );
}

function Section({ id, title, hint, count, children, className = "" }: { id: string; title: string; hint?: string; count?: number; children: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 ${cardClass} px-4 py-4 sm:px-5 ${className}`}>
      <div className="flex items-baseline justify-between gap-3 border-b border-line pb-3">
        <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h2>
          {hint ? <p className={`mt-0.5 ${metaClass}`}>{hint}</p> : null}
        </div>
        {count !== undefined ? <span className="shrink-0 text-xs tabular-nums text-ink-3">{count}</span> : null}
      </div>
      <div className="pt-2">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="py-2 text-sm text-ink-3">{children}</p>;

function Items({ items, empty, evidenceLimit }: { items: BriefingItem[]; empty: string; evidenceLimit?: number }) {
  return items.length === 0 ? <Empty>{empty}</Empty> : <ul className="divide-y divide-line">{items.map((item) => <FindingRow key={item.key} item={item} evidenceLimit={evidenceLimit} />)}</ul>;
}

function Actions({ actions, empty }: { actions: BriefingAction[]; empty: string }) {
  return actions.length === 0 ? <Empty>{empty}</Empty> : <ul className="divide-y divide-line">{actions.map((action) => <ActionRow key={action.key} action={action} />)}</ul>;
}

// --- Agent switcher ----------------------------------------------------------

const STATUS_TEXT: Record<AgentStatusLine["status"], { tone: StatusDotTone; label: string }> = {
  ok: { tone: "healthy", label: "Reported" },
  empty: { tone: "healthy", label: "Nothing found" },
  not_configured: { tone: "neutral", label: "Not connected" },
  failed: { tone: "critical", label: "Failed" },
  rejected: { tone: "critical", label: "Invalid output" },
};

function agentTone(line: AgentStatusLine): StatusDotTone {
  if (line.status === "failed" || line.status === "rejected") return "critical";
  if (line.status === "not_configured") return "neutral";
  return line.priority === "critical" || line.priority === "high" ? "critical" : line.priority === "medium" ? "attention" : "healthy";
}

export function AgentNav({ agents, current }: { agents: AgentStatusLine[]; current: SpecialistAgentId | null }) {
  const tab = (active: boolean) =>
    `inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${active ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-3 hover:bg-hover hover:text-ink"}`;
  return (
    <nav aria-label="Agents" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex w-max gap-1 rounded-lg bg-inset p-1">
        <li>
          <Link href={COMMAND_CENTER_PATH} aria-current={current === null ? "page" : undefined} className={tab(current === null)}>
            Chief of Staff
          </Link>
        </li>
        {agents.map((line) => (
          <li key={line.agent}>
            <Link href={specialistHref(line.agent as SpecialistAgentId)} aria-current={current === line.agent ? "page" : undefined} className={tab(current === line.agent)} title={`${STATUS_TEXT[line.status].label}: ${line.summary}`}>
              <StatusDot tone={agentTone(line)} />
              {line.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// --- Chief of Staff (default view) ------------------------------------------

function PriorityCard({ item, rank }: { item: BriefingItem; rank: number }) {
  return (
    <li className={`flex min-w-0 flex-col ${cardClass} px-4 py-4`}>
      <div className="flex items-center justify-between gap-2">
        <SeverityMark severity={item.severity} />
        <span className="text-[11px] font-medium tabular-nums text-ink-4">{rank}</span>
      </div>
      <p className="mt-2 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">{item.title}</p>
      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-3">{item.detail}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        <BasisTag basis={item.basis} />
        <AgentTag agent={item.agent} />
        <span className="ml-auto">
          <OpenLink href={item.href} />
        </span>
      </div>
    </li>
  );
}

export function ChiefOfStaffView({ briefing, greeting }: { briefing: ChiefOfStaffBriefing; greeting: string }) {
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="what-matters-now" className={`${cardClass} border-t-2 border-t-accent px-5 py-6 sm:px-7`}>
        <p className={metaClass}>{greeting}.</p>
        <h2 id="what-matters-now" className="mt-3 text-[12px] font-semibold tracking-[0.06em] text-accent-text uppercase">
          What matters now
        </h2>
        <p className="mt-2 max-w-3xl text-[19px] leading-[1.45] font-medium tracking-[-0.012em] text-ink sm:text-[21px]">{briefing.recommendation}</p>
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <Tag>Recommendation</Tag>
          <span>Chief of Staff · composed only from the findings below · run {briefing.traceId.slice(0, 8)}</span>
        </p>
      </section>

      {briefing.whatMattersNow.length > 0 ? (
        <ol aria-label="Top priorities" className="grid gap-3 md:grid-cols-3">
          {briefing.whatMattersNow.map((item, index) => (
            <PriorityCard key={item.key} item={item} rank={index + 1} />
          ))}
        </ol>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-5">
        <Section id="needs-attention" title="Needs your attention" hint="Decisions and actions only you can take - system and revenue items have their own sections" count={briefing.needsAttention.length} className="lg:col-span-3">
          <Items items={briefing.needsAttention} empty="Nothing else needs a decision from you right now." evidenceLimit={3} />
        </Section>
        <Section id="system-health" title="System health" hint="Automation and system problems" count={briefing.systemHealth.length} className="lg:col-span-2">
          <Items items={briefing.systemHealth} empty="No system findings." evidenceLimit={2} />
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Section id="revenue" title="Revenue" hint="Pipeline leakage and revenue opportunities" count={briefing.revenue.length} className="lg:col-span-3">
          <Items items={briefing.revenue} empty="No revenue leaks or opportunities stand out." evidenceLimit={2} />
        </Section>
        <Section id="trackpr-handling" title="Trackpr is handling" hint="Already in hand - nothing for you unless it stalls" count={briefing.trackprHandling.length} className="lg:col-span-2">
          <Items items={briefing.trackprHandling} empty="Nothing in flight for Trackpr right now." evidenceLimit={5} />
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section id="next-actions" title="Recommended next actions" hint="Recommendations - you act through the existing screens" count={briefing.nextActions.length}>
          <Actions actions={briefing.nextActions} empty="No actions recommended." />
        </Section>
        <Section id="approvals" title="Waiting for your approval" hint="Proposed only. Nothing here runs on its own" count={briefing.approvals.length}>
          <Actions actions={briefing.approvals} empty="Nothing proposed that needs approval." />
        </Section>
      </div>
    </div>
  );
}

// --- Specialist drill-down -----------------------------------------------------

const DATA_SOURCE_LABEL: Record<string, string> = {
  decisions: "Today's decision items",
  business_metrics: "Business metrics (30 days)",
  organization_health: "Automation health",
  automation_incidents: "Automation incidents",
  automation_mode: "Workspace mode",
  prospect_research: "Prospect research notes",
  market_research: "Market research notes",
  agent_results: "Specialist results",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-ink-4">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-ink-2">{children}</dd>
    </div>
  );
}

export function SpecialistView({ result, status }: { result: AgentResult | undefined; status: AgentStatusLine }) {
  const definition = AGENT_REGISTRY[status.agent];
  const findings = result?.findings ?? [];
  const recommendations: Recommendation[] = result?.recommendations ?? [];
  const items: ItemLike[] = findings.map((f) => ({ key: f.id, agent: status.agent, severity: f.severity, confidence: f.confidence, basis: f.basis, title: f.title, detail: f.detail, evidence: f.evidence, sources: f.sources, href: f.href }));
  const actions: ActionLike[] = recommendations.map((r) => ({ key: r.id, agent: status.agent, title: r.title, detail: r.detail, priority: r.priority, confidence: r.confidence, requiresApproval: r.requiresApproval, href: r.href }));

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="specialist-name" className={`${cardClass} px-5 py-5 sm:px-6`}>
        <Link href={COMMAND_CENTER_PATH} className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-3 hover:text-ink">
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          Chief of Staff
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <h2 id="specialist-name" className="text-[19px] font-semibold tracking-[-0.015em] text-ink">
            {definition.name}
          </h2>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3">
            <StatusDot tone={agentTone(status)} />
            {STATUS_TEXT[status.status].label}
          </span>
          {definition.scope === "platform" ? <Tag>About Trackpr itself · no customer data</Tag> : null}
        </div>
        <p className="mt-1 max-w-3xl text-[13px] leading-snug text-ink-3">{definition.purpose}</p>
        <p className="mt-3 max-w-3xl text-[15px] leading-snug font-medium text-ink">{status.summary}</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 sm:grid-cols-4">
          <Fact label="Highest severity">{SEVERITY_LABEL[result?.priority ?? "info"]}</Fact>
          <Fact label="Lowest confidence">{CONFIDENCE_LABEL[result?.confidence ?? "low"].replace(" confidence", "")}</Fact>
          <Fact label="Autonomy">Read-only · recommends</Fact>
          <Fact label="Reads">{definition.allowedDataSources.map((s) => DATA_SOURCE_LABEL[s] ?? s).join(", ")}</Fact>
          {result ? <Fact label="Run">{`${result.runId.slice(0, 8)} · ${result.durationMs} ms`}</Fact> : null}
          {result?.error ? <Fact label="Error">{result.error}</Fact> : null}
        </dl>
      </section>

      <div className="grid gap-5 lg:grid-cols-5">
        <Section id="specialist-findings" title="Findings" hint="Facts read from Trackpr's data, and inferences drawn from them" count={items.length} className="lg:col-span-3">
          {items.length === 0 ? (
            <Empty>{status.status === "not_configured" ? "No source is connected for this agent yet. It is interface-only in this phase and fetches nothing." : status.status === "failed" ? "This agent could not run, so its area is not covered." : "Nothing found."}</Empty>
          ) : (
            <ul className="divide-y divide-line">{items.map((item) => <FindingRow key={item.key} item={item} evidenceLimit={10} showAgent={false} />)}</ul>
          )}
        </Section>
        <Section id="specialist-recommendations" title="Recommendations" hint="Proposed only - approval items are never executed here" count={actions.length} className="lg:col-span-2">
          {actions.length === 0 ? <Empty>No recommendations.</Empty> : <ul className="divide-y divide-line">{actions.map((action) => <ActionRow key={action.key} action={action} showAgent={false} />)}</ul>}
        </Section>
      </div>
    </div>
  );
}
