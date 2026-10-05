import Link from "next/link";
import { ArrowUpRight, Lock } from "lucide-react";
import type { AgentStatusLine, BriefingAction, BriefingItem, ChiefOfStaffBriefing } from "@/lib/agents/agents/chief-of-staff";
import type { Severity } from "@/lib/agents/contract";
import { StatusDot, type StatusDotTone } from "@/lib/ui/status-dot";
import { cardClass } from "@/lib/ui/surface";
import { metaClass } from "@/lib/ui/typography";

/**
 * Trackpr Intelligence console - the Chief of Staff's briefing, rendered.
 * Presentation only: every line arrives from lib/agents. Nothing on this
 * page executes anything - links open the existing screens, where every
 * existing gate (outbound, payment, RLS) still applies; approval items are
 * listed, never actionable here.
 */

const TONE_BY_SEVERITY: Record<Severity, StatusDotTone> = { critical: "critical", high: "critical", medium: "attention", low: "neutral", info: "healthy" };
const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "inference" | "approval" }) {
  const toneClass = tone === "inference" ? "border-info-border bg-info-muted text-info-text" : tone === "approval" ? "border-warning-border bg-warning-muted text-warning-text" : "border-line bg-inset text-ink-3";
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${toneClass}`}>{children}</span>;
}

function ItemRow({ item }: { item: BriefingItem }) {
  const body = (
    <>
      <StatusDot tone={TONE_BY_SEVERITY[item.severity]} className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{item.title}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{item.detail}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Tag tone={item.basis === "inference" ? "inference" : "neutral"}>{item.basis === "fact" ? "Fact" : "Inference"}</Tag>
          <Tag>{item.agentName}</Tag>
          <span className="sr-only">Severity {SEVERITY_LABEL[item.severity]}.</span>
          {item.confidence !== "high" ? <Tag>{item.confidence === "medium" ? "Medium confidence" : "Low confidence"}</Tag> : null}
        </div>
      </div>
      {item.href ? <ArrowUpRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-2" /> : null}
    </>
  );
  return (
    <li>
      {item.href ? (
        <Link href={item.href} className="group -mx-2 flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-hover">
          {body}
        </Link>
      ) : (
        <div className="-mx-2 flex gap-3 px-2 py-2.5">{body}</div>
      )}
    </li>
  );
}

function Section({ id, title, items, empty, className = "" }: { id: string; title: string; items: BriefingItem[]; empty: string; className?: string }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 ${cardClass} px-4 py-4 sm:px-5 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-[13px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
          {title}
        </h2>
        <span className={metaClass}>{items.length}</span>
      </div>
      {items.length === 0 ? <p className="mt-3 text-sm text-ink-3">{empty}</p> : <ul className="mt-2 divide-y divide-line">{items.map((item) => <ItemRow key={item.key} item={item} />)}</ul>}
    </section>
  );
}

function ActionRow({ action }: { action: BriefingAction }) {
  return (
    <li className="flex gap-3 py-2.5">
      {action.requiresApproval ? <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning-text" /> : <StatusDot tone={TONE_BY_SEVERITY[action.priority]} className="mt-[7px]" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{action.href && !action.requiresApproval ? <Link href={action.href} className="underline-offset-2 hover:underline">{action.title}</Link> : action.title}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{action.detail}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Tag>Recommendation</Tag>
          <Tag>{action.agentName}</Tag>
          {action.requiresApproval ? <Tag tone="approval">Needs your approval · not executed</Tag> : null}
        </div>
      </div>
    </li>
  );
}

const STATUS_TEXT: Record<AgentStatusLine["status"], { tone: StatusDotTone; label: string }> = {
  ok: { tone: "healthy", label: "Reported" },
  empty: { tone: "healthy", label: "Nothing found" },
  not_configured: { tone: "neutral", label: "Not connected" },
  failed: { tone: "critical", label: "Failed" },
  rejected: { tone: "critical", label: "Invalid output" },
};

export function BriefingConsole({ briefing, greeting }: { briefing: ChiefOfStaffBriefing; greeting: string }) {
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="todays-recommendation" className="overflow-hidden rounded-xl bg-panel-dark px-5 py-6 text-on-dark shadow-card sm:px-7 sm:py-7">
        <p className="text-sm text-on-dark-3">{greeting}.</p>
        <h2 id="todays-recommendation" className="mt-4 text-[12px] font-semibold tracking-[0.08em] text-on-dark-3 uppercase">
          Today&rsquo;s recommendation
        </h2>
        <p className="mt-2 max-w-3xl text-[19px] leading-[1.45] font-medium tracking-[-0.01em] text-on-dark sm:text-[21px]">{briefing.recommendation}</p>
        <p className="mt-4 text-xs text-on-dark-3">
          Chief of Staff · composed only from the findings below · run {briefing.traceId.slice(0, 8)}
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <Section id="needs-attention" title="Needs your attention" items={briefing.needsAttention} empty="Nothing urgent." className="lg:col-span-2" />
        <Section id="system-health" title="System health" items={briefing.systemHealth} empty="No system findings." />
        <Section id="opportunities" title="Opportunities" items={briefing.opportunities} empty="No opportunities stand out." />
        <Section id="sales" title="Sales" items={briefing.sales} empty="No sales work needs a person." />
        <Section id="market" title="Market" items={briefing.market} empty="No market sources connected yet." />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="next-actions" className={`min-w-0 ${cardClass} px-4 py-4 sm:px-5`}>
          <h2 id="next-actions" className="text-[13px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
            Recommended next actions
          </h2>
          {briefing.nextActions.length === 0 ? <p className="mt-3 text-sm text-ink-3">No actions recommended.</p> : <ul className="mt-1 divide-y divide-line">{briefing.nextActions.map((a) => <ActionRow key={a.key} action={a} />)}</ul>}
        </section>
        <section aria-labelledby="approvals" className={`min-w-0 ${cardClass} px-4 py-4 sm:px-5`}>
          <h2 id="approvals" className="text-[13px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
            Waiting for your approval
          </h2>
          {briefing.approvals.length === 0 ? <p className="mt-3 text-sm text-ink-3">Nothing proposed that needs approval.</p> : <ul className="mt-1 divide-y divide-line">{briefing.approvals.map((a) => <ActionRow key={a.key} action={a} />)}</ul>}
        </section>
      </div>

      <section aria-labelledby="agents" className="px-1">
        <h2 id="agents" className="sr-only">
          Agents
        </h2>
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          {briefing.agents.map((agent) => (
            <li key={agent.agent} className="inline-flex items-center gap-1.5 text-xs text-ink-3" title={agent.summary}>
              <StatusDot tone={STATUS_TEXT[agent.status].tone} />
              <span className="font-medium text-ink-2">{agent.name}</span>
              <span>{STATUS_TEXT[agent.status].label}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
