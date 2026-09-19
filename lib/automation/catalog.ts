import type { LucideIcon } from "lucide-react";
import { Zap, MessageSquareReply, ShieldCheck, CalendarClock, BellRing, FileText, Wrench, Star, HeartPulse, RotateCcw } from "lucide-react";

/**
 * Centralized, typed catalog of Trackpr's automation capabilities -
 * discovered from the actual implementation under lib/automation/*.ts, not
 * assumed. This is the single source every Automation Control Center
 * component reads from; nothing duplicates this list elsewhere.
 *
 * Three real architectural distinctions this catalog preserves, since the
 * live system does not treat every automation the same way:
 *
 * - `kind: "event-triggered"` - dispatched synchronously from a CRUD action
 *   (creating a lead, an appointment, a job, marking one completed, an
 *   inbound SMS arriving) via createAutomationEvent + startWorkflowExecution
 *   + an after()-deferred call to n8n.
 * - `kind: "scheduled"` - dispatched from one of the four Vercel Cron routes
 *   (app/api/automation/{appointment-reminders,estimate-followups,
 *   lead-nurture,lead-reactivation}/route.ts), which scan for candidates on
 *   a schedule rather than reacting to a single event.
 * - `kind: "safety-layer"` - not independently triggered at all. Safe AI
 *   Outbound is lib/automation/outbound-gate.ts's evaluateOutboundGate() -
 *   the single chokepoint every AI-drafted message (n8n-dispatched or
 *   Trackpr-composed) passes through before it can reach a customer. It has
 *   no event_type or workflow_name of its own, so it is represented as
 *   infrastructure, never as a fake independent workflow.
 *
 * `dispatch` separately records HOW the outbound message gets written:
 * `"n8n"` (AI-drafted, dispatched to the n8n orchestrator), `"trackpr"`
 * (composed directly in Trackpr from a plain template - Appointment
 * Reminders and the scheduled half of Estimate Follow-Up - no AI, no n8n
 * round trip), or `"none"` (Safe AI Outbound itself sends nothing; it only
 * gates what other automations send).
 */

export type AutomationKind = "event-triggered" | "scheduled" | "safety-layer";
export type AutomationDispatch = "n8n" | "trackpr" | "none";

export type AutomationDefinition = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: LucideIcon;
  kind: AutomationKind;
  trigger: string;
  /** automation_events.event_type values this automation writes/reads. Empty for the one safety-layer capability, which has no event of its own. */
  eventTypes: string[];
  /** workflow_executions.workflow_name values this automation dispatches under - also the n8n webhook path for dispatch: "n8n" entries. Empty when nothing is dispatched. */
  workflowNames: string[];
  dispatch: AutomationDispatch;
  /** Ordered, human-readable steps for the detail page's "How it works" section - only steps that are actually implemented, never invented. */
  steps: string[];
};

export const AUTOMATION_CATALOG: AutomationDefinition[] = [
  {
    id: "instant-lead-followup",
    name: "Instant Lead Follow-Up",
    description: "Drafts and sends a first-response SMS the moment a new lead comes in.",
    category: "Leads",
    icon: Zap,
    kind: "event-triggered",
    trigger: "New lead created",
    eventTypes: ["lead.created"],
    workflowNames: ["lead_created_followup"],
    dispatch: "n8n",
    steps: [
      "Trigger: a new lead is created",
      "Trackpr records the lead.created event and starts a workflow execution",
      "n8n drafts a first-response SMS using the organization's AI settings and the lead's details",
      "Trackpr's callback route records the AI result",
      "Safe AI Outbound gate re-verifies opt-out status, content safety, and duplicate-send protection",
      "Message sent through the same conversation every other channel uses",
      "Execution recorded as completed",
    ],
  },
  {
    id: "inbound-customer-reply",
    name: "Inbound Customer Reply",
    description: "Analyzes an inbound SMS reply and drafts a contextual AI response.",
    category: "Conversations",
    icon: MessageSquareReply,
    kind: "event-triggered",
    trigger: "Customer sends an inbound SMS reply",
    eventTypes: ["customer.message.received"],
    workflowNames: ["customer_reply_followup"],
    dispatch: "n8n",
    steps: [
      "Trigger: an inbound SMS arrives at the Twilio webhook (STOP/START/HELP handled separately, never reach this path)",
      "Trackpr records the customer.message.received event and starts a workflow execution",
      "n8n drafts a response using recent conversation history, the lead's context, and AI settings",
      "Trackpr's callback route records the AI result",
      "Safe AI Outbound gate re-verifies opt-out status, content safety, and duplicate-send protection",
      "Message sent through the existing conversation",
      "Execution recorded as completed",
    ],
  },
  {
    id: "safe-ai-outbound",
    name: "Safe AI Outbound",
    description:
      "The centralized safety gate every AI-drafted message passes through before it can reach a customer - opt-out enforcement, content-safety screening, duplicate-send prevention, and live status re-verification.",
    category: "Safety",
    icon: ShieldCheck,
    kind: "safety-layer",
    trigger: "Every AI-drafted outbound message, immediately before it sends",
    eventTypes: [],
    workflowNames: [],
    dispatch: "none",
    steps: [
      "An AI-drafted message is about to be sent by any other automation on this list",
      "Confirm the AI actually recommended sending, and no human handoff was flagged",
      "Screen the message text against the content-safety backstop",
      "Confirm the contact has not opted out",
      "Re-verify the conversation, and where relevant the appointment, estimate, job, or lead, are still in a state that makes this specific message safe to send right now",
      "Confirm no message has already been sent for this exact execution",
      "Only then hand off to the outbound send path",
    ],
  },
  {
    id: "appointment-lifecycle",
    name: "Appointment Lifecycle",
    description: "Sends a confirmation when an appointment is booked, and a recovery message if the customer no-shows.",
    category: "Appointments",
    icon: CalendarClock,
    kind: "event-triggered",
    trigger: "Appointment created or marked no-show",
    eventTypes: ["appointment.created", "appointment.no_show"],
    workflowNames: ["appointment_created_followup", "appointment_no_show_followup"],
    dispatch: "n8n",
    steps: [
      "Trigger: an appointment is created, or marked no-show",
      "Trackpr records the corresponding event and starts a workflow execution",
      "n8n drafts a confirmation or recovery message",
      "Trackpr's callback route records the AI result",
      "Safe AI Outbound gate re-verifies the appointment is still in an eligible status before sending",
      "Message sent",
      "Execution recorded as completed",
    ],
  },
  {
    id: "appointment-reminders",
    name: "Appointment Reminders",
    description: "Sends a reminder 24 hours before an upcoming appointment. Composed directly by Trackpr, no AI drafting.",
    category: "Appointments",
    icon: BellRing,
    kind: "scheduled",
    trigger: "Scheduled - runs on a recurring schedule, 24 hours before each appointment",
    eventTypes: ["appointment.reminder"],
    workflowNames: ["appointment_reminder"],
    dispatch: "trackpr",
    steps: [
      "Scheduled run scans for appointments due their 24-hour reminder",
      "Trackpr composes the reminder text directly (date, time, opt-out line) - no AI, no n8n round trip",
      "Trackpr records the appointment.reminder event and workflow execution",
      "Safe AI Outbound gate still re-verifies opt-out status and duplicate-send protection",
      "Message sent",
      "Execution recorded as completed",
    ],
  },
  {
    id: "estimate-followup",
    name: "Estimate Follow-Up",
    description: "Sends an AI-drafted notification when an estimate is sent, then scheduled check-ins if it stays unanswered.",
    category: "Estimates",
    icon: FileText,
    kind: "event-triggered",
    trigger: "Estimate sent, then scheduled check-ins while it remains unanswered",
    eventTypes: ["estimate.sent", "estimate.followup", "estimate.expired"],
    workflowNames: ["estimate_sent_followup", "estimate_followup", "estimate_expired_lifecycle"],
    dispatch: "n8n",
    steps: [
      "Trigger: an estimate is sent - n8n drafts the initial AI notification",
      "Scheduled run separately scans `sent` estimates for their next check-in (24h, then 72h) or expiration",
      "Follow-up check-ins are composed directly by Trackpr - no AI, no n8n round trip",
      "Safe AI Outbound gate re-verifies the estimate is still in an eligible status before sending",
      "Message sent",
      "Execution recorded as completed",
    ],
  },
  {
    id: "job-lifecycle",
    name: "Job Lifecycle",
    description: "Sends an AI-drafted kickoff notification when a job is created from an accepted estimate.",
    category: "Jobs",
    icon: Wrench,
    kind: "event-triggered",
    trigger: "Job created from an accepted estimate",
    eventTypes: ["job.created"],
    workflowNames: ["job_created_followup"],
    dispatch: "n8n",
    steps: [
      "Trigger: an estimate is accepted, creating exactly one job",
      "Trackpr records the job.created event and starts a workflow execution",
      "n8n drafts a kickoff notification",
      "Trackpr's callback route records the AI result",
      "Safe AI Outbound gate re-verifies the job is still in an eligible status before sending",
      "Message sent",
      "Execution recorded as completed",
    ],
  },
  {
    id: "review-referral-followup",
    name: "Review & Referral Follow-Up",
    description: "Sends a combined thank-you, review request, and referral ask after a job is marked completed.",
    category: "Jobs",
    icon: Star,
    kind: "event-triggered",
    trigger: "Job marked completed",
    eventTypes: ["job.post_followup"],
    workflowNames: ["post_job_followup"],
    dispatch: "n8n",
    steps: [
      "Trigger: a job is marked completed",
      "Trackpr records the job.post_followup event and starts a workflow execution",
      "n8n drafts one combined thank-you / review / referral message",
      "Trackpr's callback route records the AI result",
      "Safe AI Outbound gate re-verifies the job is still marked completed before sending",
      "Message sent",
      "Execution recorded as completed",
    ],
  },
  {
    id: "lost-lead-nurture",
    name: "Lost Lead Nurture",
    description: "Sends up to two scheduled check-in messages to a lead marked lost, spaced days apart.",
    category: "Leads",
    icon: HeartPulse,
    kind: "scheduled",
    trigger: "Scheduled - runs on a recurring schedule, timed from when a lead is marked lost",
    eventTypes: ["lead.lost_nurture"],
    workflowNames: ["lead_lost_nurture_followup"],
    dispatch: "n8n",
    steps: [
      "A lead is marked lost (recorded as its own lifecycle event, not independently listed here)",
      "Scheduled run finds leads due their first (7-day) or second (21-day) nurture touch",
      "n8n drafts a check-in message",
      "Trackpr's callback route records the AI result",
      "Safe AI Outbound gate re-verifies the lead is still lost before sending",
      "Message sent",
      "Execution recorded as completed",
    ],
  },
  {
    id: "lead-reactivation",
    name: "Lead Reactivation",
    description: "Sends scheduled re-engagement messages to leads that have gone quiet with no active appointment, estimate, or job.",
    category: "Leads",
    icon: RotateCcw,
    kind: "scheduled",
    trigger: "Scheduled - runs on a recurring schedule, based on lead inactivity",
    eventTypes: ["lead.reactivation"],
    workflowNames: ["lead_reactivation_followup"],
    dispatch: "n8n",
    steps: [
      "Scheduled run finds open leads with no recent inbound activity and no active appointment, estimate, or job",
      "n8n drafts a re-engagement message",
      "Trackpr's callback route records the AI result",
      "Safe AI Outbound gate re-verifies the lead is still inactive and has no active engagement before sending",
      "Message sent",
      "Execution recorded as completed",
    ],
  },
];

export function getAutomationDefinition(id: string): AutomationDefinition | null {
  return AUTOMATION_CATALOG.find((a) => a.id === id) ?? null;
}

/**
 * The single event_type -> automation mapping for the whole codebase (Phase
 * C enable/disable enforcement). Deliberately reuses eventTypes rather than
 * a second, independently-maintained lookup table - if a future automation
 * adds an event type to its catalog entry, enforcement picks it up
 * automatically with no second edit required. Returns null for an event
 * type no catalog entry claims (e.g. the internal `lead.lost` lifecycle
 * marker, which has no dispatched workflow or user-facing automation of its
 * own) - callers must treat null as "nothing to enforce here", never as an
 * error, so uncatalogued internal events keep their exact existing behavior.
 */
export function getAutomationForEventType(eventType: string): AutomationDefinition | null {
  return AUTOMATION_CATALOG.find((a) => a.eventTypes.includes(eventType)) ?? null;
}

/**
 * Phase F fallback for execution-detail display: resolves a catalog
 * automation directly from a workflow_executions.workflow_name, for the
 * rare case an execution's automation_event_id is null (the FK is ON
 * DELETE SET NULL) and getAutomationForEventType has no event_type to work
 * from at all. Not used anywhere eligibility/authorization depends on -
 * purely a display-label lookup.
 */
export function getAutomationForWorkflowName(workflowName: string): AutomationDefinition | null {
  return AUTOMATION_CATALOG.find((a) => a.workflowNames.includes(workflowName)) ?? null;
}
