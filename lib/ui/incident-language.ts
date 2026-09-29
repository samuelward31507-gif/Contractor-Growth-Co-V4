import type { IncidentCategory } from "@/lib/automation-health/types";

/**
 * Trackpr 2.0 (step 2D): the contractor-facing sentence for each automation
 * incident category - what happened to their business, never how the
 * infrastructure failed. Presentation only: the categories, their meaning
 * and how they are recorded are unchanged (lib/automation-health).
 *
 * Every sentence stays inside what the category actually proves. Trackpr's
 * automations span lead follow-up, reminders, estimate follow-up and job
 * updates, so a generic workflow failure is "an automated task", never a
 * guessed consequence like "new leads aren't being followed up". Only the
 * message categories can truthfully name a customer message.
 */
export const INCIDENT_SENTENCE: Record<IncidentCategory, string> = {
  workflow_failed: "An automated task didn't finish.",
  repeated_workflow_failure: "An automated task keeps failing.",
  workflow_stuck: "An automated task is running late.",
  n8n_dispatch_failed: "An automated task couldn't start.",
  n8n_callback_failed: "Trackpr couldn't confirm an automated task finished.",
  sms_send_failed: "A text message couldn't be sent.",
  sms_delivery_failed: "A customer message couldn't be delivered.",
  human_escalation_requested: "A customer conversation needs a person to reply.",
  scheduled_automation_stale: "A scheduled task may not have run on time.",
  online_payment_reconciliation: "An online payment needs your review.",
};

/** Short labels for dense lists (the Automations incident rows). */
export const INCIDENT_LABEL: Record<IncidentCategory, string> = {
  workflow_failed: "Task didn't finish",
  repeated_workflow_failure: "Task keeps failing",
  workflow_stuck: "Task running late",
  n8n_dispatch_failed: "Task couldn't start",
  n8n_callback_failed: "Completion not confirmed",
  sms_send_failed: "Text not sent",
  sms_delivery_failed: "Message not delivered",
  human_escalation_requested: "Needs a person",
  scheduled_automation_stale: "Scheduled task late",
  online_payment_reconciliation: "Payment review",
};

/**
 * Categories whose backend-written title and description are already plain,
 * actionable business language (e.g. "Stripe collected $425.50 for
 * INV-000001, but Trackpr could not record it... Find this payment in your
 * Stripe dashboard, then record it on the invoice or refund it."). The
 * Automations list shows those words as the explanation itself instead of
 * moving them behind "Technical details". Phase 1C's payment reconciliation
 * incidents (lib/payments/online-payment.ts) are written this way.
 */
export const SELF_DESCRIBING_INCIDENT_CATEGORIES: ReadonlySet<IncidentCategory> = new Set<IncidentCategory>(["online_payment_reconciliation"]);

/** The neutral fallbacks for a category this map doesn't know (e.g. one added by a newer backend). */
export const GENERIC_INCIDENT_SENTENCE = "Something needs a look.";
export const GENERIC_INCIDENT_LABEL = "Needs a look";
