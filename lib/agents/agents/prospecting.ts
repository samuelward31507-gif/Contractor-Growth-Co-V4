import { z } from "zod";
import { HttpsUrlSchema, type AgentOutput, type Confidence, type Finding, type Recommendation } from "../contract";
import { formatCount, plural } from "../format";

/**
 * Prospecting agent - Trackpr's OWN growth, never customer automation.
 *
 * Phase 1 is the interface: research inputs a person supplies (a company, its
 * vertical, what was observed and where) become a structured prospect with
 * a likely pain point, Trackpr fit, reason to contact and suggested angle.
 * The agent fetches nothing and scrapes nothing; contacting a prospect is
 * always a requires-approval recommendation. With no inputs connected it
 * reports "not configured" rather than inventing prospects.
 */

export const PROSPECT_VERTICALS = ["contractor", "peptide", "gym", "clinic"] as const;
export type ProspectVertical = (typeof PROSPECT_VERTICALS)[number];

export const ProspectResearchInputSchema = z
  .object({
    company: z.string().trim().min(1).max(200),
    vertical: z.enum(PROSPECT_VERTICALS),
    /** What was observed, e.g. "no online booking", "replies to web leads next day". */
    signals: z
      .array(z.object({ observation: z.string().trim().min(1).max(300), source: HttpsUrlSchema.optional() }).strict())
      .max(10)
      .default([]),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export type ProspectResearchInput = z.input<typeof ProspectResearchInputSchema>;

/** What Trackpr actually does for each vertical - the only basis for "fit". */
export const VERTICAL_PLAYBOOK: Record<ProspectVertical, { label: string; pain: string; fit: string; angle: string }> = {
  contractor: {
    label: "Contractors",
    pain: "Leads go cold between the first call and the estimate; quotes go out with no follow-up.",
    fit: "Lead response, appointment reminders, estimate follow-ups and invoice reminders.",
    angle: "Show the estimates they sent last month that never got a second touch.",
  },
  peptide: {
    label: "Peptide businesses",
    pain: "Inquiries need fast, careful qualification and consistent follow-up.",
    fit: "Fast first response and structured follow-up, with a person kept in the loop for anything clinical.",
    angle: "Response time on inbound inquiries - and how many never get a second message.",
  },
  gym: {
    label: "Gyms",
    pain: "Trial and walk-in leads drop off before they become members; lapsed members are never re-engaged.",
    fit: "Lead follow-up, check-in and membership tracking, and reactivation of dormant members.",
    angle: "How many trial leads from the last 30 days never became members.",
  },
  clinic: {
    label: "Clinics, med spas and dental",
    pain: "No-shows and unconfirmed appointments leave chairs empty; recall patients are never re-booked.",
    fit: "Appointment confirmation and reminders, no-show recovery and reactivation.",
    angle: "Their no-show rate and the cost of one empty slot a day.",
  },
};

function prospectConfidence(input: z.output<typeof ProspectResearchInputSchema>): Confidence {
  // Never "high": fit is always an inference until someone talks to the business.
  return input.signals.some((s) => s.source) ? "medium" : "low";
}

export function analyzeProspecting(inputs: ProspectResearchInput[]): AgentOutput {
  if (inputs.length === 0) {
    return {
      status: "not_configured",
      summary: "No prospect research inputs yet. Prospecting is interface-only in this phase and never contacts anyone.",
      findings: [],
      recommendations: [],
      metadata: { inputs: 0 },
    };
  }

  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  let rejected = 0;
  inputs.forEach((raw, index) => {
    const parsed = ProspectResearchInputSchema.safeParse(raw);
    if (!parsed.success) {
      rejected += 1;
      return;
    }
    const prospect = parsed.data;
    const playbook = VERTICAL_PLAYBOOK[prospect.vertical];
    const confidence = prospectConfidence(prospect);
    const id = `prospect:${index}`;
    findings.push({
      id,
      kind: "opportunity",
      basis: "inference",
      severity: "low",
      confidence,
      category: `prospect_${prospect.vertical}`,
      title: `${prospect.company} - ${playbook.label}`,
      detail: `Likely pain: ${playbook.pain} Trackpr fit: ${playbook.fit}`,
      evidence: [
        ...prospect.signals.slice(0, 5).map((s) => ({ label: "Observed", value: s.observation })),
        { label: "Reason to contact", value: prospect.signals[0]?.observation ?? "Vertical match only - no specific signal recorded." },
        { label: "Suggested angle", value: playbook.angle },
      ],
      sources: prospect.signals.filter((s) => s.source).slice(0, 5).map((s) => ({ title: s.observation.slice(0, 200), url: s.source as string })),
    });
    recommendations.push({
      id: `${id}:contact`,
      title: `Reach out to ${prospect.company}`,
      detail: `Suggested angle: ${playbook.angle}`,
      actionKind: "contact_prospect",
      autonomy: "requires_approval",
      requiresApproval: true,
      priority: "low",
      confidence,
      relatedFindingIds: [id],
    });
  });

  return {
    status: findings.length === 0 ? "empty" : "ok",
    summary: `${formatCount(findings.length)} ${plural(findings.length, "prospect", "prospects")} assessed${rejected > 0 ? `, ${formatCount(rejected)} research ${plural(rejected, "input", "inputs")} rejected as malformed` : ""}.`,
    findings,
    recommendations,
    metadata: { inputs: inputs.length, rejected },
  };
}
