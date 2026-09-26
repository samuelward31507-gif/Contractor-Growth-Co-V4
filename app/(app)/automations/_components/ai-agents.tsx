import Link from "next/link";
import { getAutomationDefinition } from "@/lib/automation/catalog";
import { Badge } from "@/lib/ui/badge";
import { AUTOMATION_STATUS_BADGE, formatCount, formatRelativeTime } from "./format";
import type { AutomationDisplayStatus, AutomationSummary } from "@/lib/automation/queries";

/**
 * Trackpr 2.0 Phase 3: presentation-only "AI agent" framing over the
 * existing automation catalog - deliberately NOT a new field on
 * AutomationDefinition or a new query. Grouped strictly by dispatch: "n8n"
 * (see lib/automation/catalog.ts's own dispatch documentation) - the
 * dispatch: "trackpr" automations (Missed Call Recovery, Appointment
 * Reminders, Old Customer Reactivation) are template-only, no AI drafting
 * involved, so they are never framed as an agent here; Safe AI Outbound is
 * infrastructure (dispatch: "none"), not an agent either. Where one agent
 * covers more than one catalog automation (Job & Review, Reactivation),
 * that grouping reflects the real product story - separate customer-facing
 * moments the same kind of drafting work serves - not a technical merge.
 */
const AGENT_GROUPS: { name: string; description: string; automationIds: string[] }[] = [
  {
    name: "Lead Response Agent",
    description: "Drafts the first reply to a new lead within moments of it coming in.",
    automationIds: ["instant-lead-followup"],
  },
  {
    name: "Conversation Agent",
    description: "Reads each inbound text and drafts a contextual reply.",
    automationIds: ["inbound-customer-reply"],
  },
  {
    name: "Booking Agent",
    description: "Drafts appointment confirmations and no-show recovery messages.",
    automationIds: ["appointment-lifecycle"],
  },
  {
    name: "Follow-Up Agent",
    description: "Drafts the notification sent when an estimate goes out.",
    automationIds: ["estimate-followup"],
  },
  {
    name: "Job & Review Agent",
    description: "Drafts job kickoff notices, then the post-job review and referral ask.",
    automationIds: ["job-lifecycle", "review-referral-followup"],
  },
  {
    name: "Reactivation Agent",
    description: "Drafts check-ins for leads gone quiet and re-engagement for lost ones.",
    automationIds: ["lost-lead-nurture", "lead-reactivation"],
  },
];

/** workflow_executions.workflow_name values every AI agent above dispatches under - used to scope the Recent AI Activity feed to genuinely AI-drafted work only. */
export function getAiAgentWorkflowNames(): string[] {
  return AGENT_GROUPS.flatMap((group) => group.automationIds).flatMap((id) => getAutomationDefinition(id)?.workflowNames ?? []);
}

const STATUS_PRIORITY: AutomationDisplayStatus[] = ["attention", "active", "no_activity", "not_configured", "disabled"];

function worstStatus(statuses: AutomationDisplayStatus[]): AutomationDisplayStatus {
  for (const candidate of STATUS_PRIORITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "no_activity";
}

export function AiAgents({ summaries }: { summaries: AutomationSummary[] }) {
  const byId = new Map(summaries.map((s) => [s.definition.id, s]));

  const agents = AGENT_GROUPS.map((group) => {
    const members = group.automationIds.map((id) => byId.get(id)).filter((s): s is AutomationSummary => s != null);
    if (members.length === 0) return null;

    const totalExecutions = members.reduce((sum, m) => sum + m.totalExecutions, 0);
    const failedExecutions = members.reduce((sum, m) => sum + m.failedExecutions, 0);
    const lastExecutionAt = members.reduce<string | null>((latest, m) => {
      if (!m.lastExecutionAt) return latest;
      if (!latest || new Date(m.lastExecutionAt) > new Date(latest)) return m.lastExecutionAt;
      return latest;
    }, null);

    return {
      name: group.name,
      description: group.description,
      icon: members[0].definition.icon,
      status: worstStatus(members.map((m) => m.status)),
      totalExecutions,
      failedExecutions,
      lastExecutionAt,
      href: `/automations/${members[0].definition.id}`,
    };
  }).filter((agent): agent is NonNullable<typeof agent> => agent != null);

  if (agents.length === 0) return null;

  return (
    <div>
      <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">AI agents</p>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <ul className="divide-y divide-slate-100">
          {agents.map((agent) => {
            const Icon = agent.icon;
            const statusBadge = AUTOMATION_STATUS_BADGE[agent.status];
            return (
              <li key={agent.name}>
                <Link
                  href={agent.href}
                  className="group flex items-start gap-3.5 px-4 py-4 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900/10 sm:items-center"
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      agent.status === "active" ? "bg-emerald-50 text-emerald-600" : agent.status === "attention" ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[15px] font-semibold text-slate-900">{agent.name}</p>
                      <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                        {statusBadge.label}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">{agent.description}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>{formatCount(agent.totalExecutions)} handled (30d)</span>
                      <span>Last activity: {agent.lastExecutionAt ? formatRelativeTime(agent.lastExecutionAt) : "—"}</span>
                      {agent.failedExecutions > 0 ? <span className="font-medium text-red-600">{formatCount(agent.failedExecutions)} failures</span> : null}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
