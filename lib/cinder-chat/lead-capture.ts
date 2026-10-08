/**
 * Where a qualified website conversation would become a lead - a boundary,
 * not an integration.
 *
 * The public Cinder site has no lead-capture backend today: the `leads`
 * table belongs to Trackpr tenants and is RLS-protected, and the
 * /get-started form hands off to email (lib/site/contact.ts). Writing chat
 * leads anywhere would need a new, separately approved destination, so the
 * default sink records nothing. Connecting one later means implementing
 * ChatLeadSink and passing it to the chat route's handler - the assistant
 * itself does not change.
 *
 * What a sink receives is deliberately thin: the visitor's intent and the
 * NAMES of the qualification facts they shared (never the values, never
 * the transcript). Contact details are collected by the Get started page,
 * where the visitor sees exactly what they send.
 */
import type { ChatIntent, QualificationSignal } from "./prompt";

export type ChatQualificationSummary = {
  intent: ChatIntent;
  signals: QualificationSignal[];
  /** True when the reply offered a meeting/next-step button. */
  nextStepOffered: boolean;
};

export interface ChatLeadSink {
  record(summary: ChatQualificationSummary): Promise<void>;
}

/** The default: nothing is stored. */
export const noopChatLeadSink: ChatLeadSink = {
  async record() {},
};

/** Only conversations that reached real buying intent are worth a lead record. */
export function isQualified(summary: ChatQualificationSummary): boolean {
  return summary.intent === "ready_to_talk" || (summary.intent === "exploring_fit" && summary.signals.includes("primary_problem") && summary.signals.includes("business_type"));
}
