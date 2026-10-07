export type SmsKeyword = "stop" | "start" | "help";

// The standard carrier-mandated keyword sets (case-insensitive, exact match
// on the trimmed body - a message that merely contains "stop" as a word,
// e.g. "please stop by tomorrow", must never match).
// STOP words are the carrier opt-out set, unchanged: US carriers (and Twilio's
// opt-out handling) block further texts on these regardless of what Trackpr
// records, so Trackpr must record the opt-out too. A bare CANCEL that answers
// an appointment message is ALSO treated as cancelling that appointment - see
// isBareCancel and lib/automation/booking-reply.ts's
// handleBareCancelAppointmentReply.
//
// Final Batch 1: START is only an explicit opt-in word. A bare "YES" is an
// ordinary reply (confirming an appointment, accepting an offered time,
// answering a question) and goes to normal handling - it never re-subscribes
// an opted-out contact in Trackpr; that takes START or UNSTOP.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);

/**
 * Matches a standard SMS compliance keyword against an inbound message body.
 * Must run before any AI/automation handling of an inbound message - opt-out
 * and help requests are compliance obligations, not conversational content.
 */
export function matchSmsKeyword(body: string): SmsKeyword | null {
  const normalized = body.trim().toLowerCase();
  if (STOP_WORDS.has(normalized)) return "stop";
  if (START_WORDS.has(normalized)) return "start";
  if (HELP_WORDS.has(normalized)) return "help";
  return null;
}

/** A bare CANCEL (case-insensitive, trimmed): a STOP keyword that may also be an appointment cancellation. */
export function isBareCancel(body: string): boolean {
  return body.trim().toLowerCase() === "cancel";
}
