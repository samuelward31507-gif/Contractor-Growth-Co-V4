/**
 * Cinder website assistant - the knowledge it may answer from.
 *
 * Deterministic and hand-maintained: every statement below restates copy
 * the public Cinder website already publishes (app/(cinder)/** - the home
 * page sections, the Trackpr product page, /get-started) or a destination
 * the site already links to. Nothing here is new product truth. When the
 * site changes, this file changes with it; the assistant is told to treat
 * anything not written here as unknown.
 *
 * Deliberately absent, because the site does not publish them: prices or
 * plans, customer names or results, statistics, guarantees, integration
 * lists beyond what the Trackpr page names, timelines, certifications.
 */
import { STAGES, PILLARS, TRACKPR_ANSWERS, WHY, FUTURE_VERTICALS } from "@/app/(cinder)/_components/content";

export type KnowledgeSection = { id: string; title: string; source: string; facts: string[] };

/** Trackpr's capabilities per stage - the exact lines the /trackpr page lists. */
const TRACKPR_STAGE_CAPABILITIES: { stage: string; does: string }[] = [
  { stage: "Lead", does: "Website form capture, missed-call recovery by text, and leads added by hand - all in one place." },
  { stage: "Response", does: "An instant first reply to every new lead, and drafted replies to inbound texts that hand off to you when a person is needed." },
  { stage: "Qualification", does: "Lead temperature and status, so hot leads and qualified-but-unbooked leads surface first." },
  { stage: "Appointment", does: "Booking against your real availability, Google Calendar sync, reminders, and no-show detection." },
  { stage: "Estimate", does: "Estimates with a customer approval link, and follow-ups while they wait for a reply." },
  { stage: "Job", does: "Jobs from accepted estimates, a kickoff notice, and review and referral requests when the work is done." },
  { stage: "Payment", does: "Invoices with an online payment page, payment history, and reminders when an invoice goes overdue." },
];

export const KNOWLEDGE: KnowledgeSection[] = [
  {
    id: "cinder",
    title: "Cinder Revenue Company",
    source: "/ (hero, company)",
    facts: [
      "Cinder Revenue Company (Cinder) is a revenue technology company. It builds revenue systems built to turn more opportunities into revenue.",
      "Cinder connects every step between a new opportunity and a final payment, so less revenue slips through the gaps.",
      "Cinder exists to make revenue less fragile: a business shouldn't need a stack of disconnected tools, spreadsheets, inboxes, reminders and manual processes to know where its revenue stands. Cinder builds the systems that connect those pieces.",
      "Cinder focuses on revenue-heavy businesses - businesses where speed, follow-through and revenue visibility matter most.",
      "Trackpr is Cinder's flagship product and its first revenue operating system.",
    ],
  },
  {
    id: "problem",
    title: "The problem Cinder solves",
    source: "/ (problem)",
    facts: [
      "Revenue doesn't disappear all at once. It leaks through small operational gaps: a late reply, a proposal nobody follows up, a payment nobody chases.",
      "Most businesses don't have a lead problem. They have a follow-through problem.",
      "Revenue is won or lost between stages - the hand-offs (first reply, follow-up, collection) are where follow-through decides the outcome.",
      ...STAGES.map((stage) => `${stage.label} stage - "${stage.question}" Where it slips: ${stage.leak}`),
    ],
  },
  {
    id: "lifecycle",
    title: "The revenue lifecycle and the Cinder system",
    source: "/ (platform)",
    facts: [
      `The revenue lifecycle has seven stages: ${STAGES.map((stage) => stage.label).join(", ")}.`,
      "The Cinder system is five disciplines on one connected record. Each covers a stretch of the lifecycle; together they cover all of it.",
      ...PILLARS.map((pillar) => `${pillar.name}: ${pillar.line} (covers: ${pillar.stages.join(", ")})`),
    ],
  },
  {
    id: "trackpr",
    title: "Trackpr",
    source: "/trackpr, /#trackpr",
    facts: [
      "Trackpr is the first revenue operating system from Cinder, and a product of Cinder Revenue Company.",
      "Trackpr gives a business visibility and follow-through across the whole revenue lifecycle - in one place.",
      "Trackpr shows what is happening with your revenue, what needs attention and what should happen next - from the first lead to the final payment.",
      "Trackpr follows each opportunity from first contact to payment, and keeps the follow-through moving at every stage. Every stage lives on one connected record.",
      "Conversations, appointments, estimates, jobs and invoices live on one record, so the whole path from first contact to paid is visible.",
      ...TRACKPR_ANSWERS.map((item) => `${item.question}: ${item.detail} (in Trackpr: ${item.area})`),
      "Today opens on the figures that matter this morning - new leads, appointments, conversations waiting on you, and what is unpaid.",
      "Needs your attention is one prioritized list - operational problems first, then the most time-sensitive opportunities - each with the reason it is there.",
      "Every item carries its next step: open the conversation, follow up the estimate, create the invoice.",
      "Opportunities surfaces customers to win back and reviews or referrals to ask for.",
    ],
  },
  {
    id: "capabilities",
    title: "What Trackpr does at each stage",
    source: "/trackpr (built on the revenue lifecycle)",
    facts: TRACKPR_STAGE_CAPABILITIES.map((item) => `${item.stage}: ${item.does}`),
  },
  {
    id: "not-a-crm",
    title: "How Trackpr differs from a CRM",
    source: "/ (why Cinder)",
    facts: [
      "Cinder's own framing: \"Not another place to enter information. A CRM stores what already happened. Cinder is built around what happens next.\"",
      ...WHY.map((item) => `${item.title}: ${item.line}`),
      "Trackpr is a revenue operating system: beyond storing records, it shows what needs attention, carries the next step on every item, and keeps follow-through moving (first replies, follow-ups, reminders, review and referral requests).",
    ],
  },
  {
    id: "who",
    title: "Who it is for today",
    source: "/#industries, /trackpr, /get-started",
    facts: [
      "Trackpr is live today, beginning with contractors and the trades - its first live vertical, shaped around how the trades win and deliver work: calls and forms, estimates, jobs and invoices (Lead -> Estimate -> Job -> Invoice -> Payment).",
      "Trades named in the site's intake form: HVAC, plumbing, electrical, roofing, remodeling, concrete, landscaping, painting, flooring, and other trades.",
      `Future verticals Cinder is building toward, none supported by Trackpr yet: ${FUTURE_VERTICALS.join(", ")}.`,
      "For a business outside contractors and the trades, Trackpr does not support it yet; Cinder is building toward other revenue-heavy businesses.",
    ],
  },
  {
    id: "working-with-cinder",
    title: "What working with Cinder looks like",
    source: "/get-started (what happens next)",
    facts: [
      "Getting started: 1) Cinder looks at how your business handles opportunities today. 2) Cinder finds where revenue is slipping between stages. 3) Cinder shows you how Trackpr would run that lifecycle. 4) If it's a fit, Cinder sets it up with you.",
      "The Get started page asks for: name, phone, email, business name, industry, website, approximate monthly lead volume, and the biggest challenge.",
      "In Trackpr, automated steps (instant first replies, follow-ups, reminders) keep things moving, and drafted replies hand off to the business when a person is needed. Trackpr shows the business what needs its attention and the next step on every item; the site does not describe a fuller split of responsibilities.",
      "Existing Trackpr users sign in at /login.",
    ],
  },
  {
    id: "not-published",
    title: "What the site does not publish",
    source: "(absence)",
    facts: [
      "No prices, plans or packages are published on the site.",
      "No customer names, case studies, testimonials, results or statistics are published.",
      "No guarantees of revenue, leads, bookings or return on investment are made.",
      "No setup timeline, contract terms, team size, location or founding date is published.",
      "Integrations named on the site: Google Calendar sync, text messaging for replies and missed-call recovery, website form capture, and an online payment page for invoices. No other integration is claimed.",
    ],
  },
];

/** The knowledge as one stable text block - identical for every request, so it caches. */
export function renderKnowledge(sections: KnowledgeSection[] = KNOWLEDGE): string {
  return sections.map((section) => [`## ${section.title} [source: ${section.source}]`, ...section.facts.map((fact) => `- ${fact}`)].join("\n")).join("\n\n");
}
