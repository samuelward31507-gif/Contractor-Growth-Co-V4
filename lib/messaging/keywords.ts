export type SmsKeyword = "stop" | "start" | "help";

// The standard carrier-mandated keyword sets (case-insensitive, exact match
// on the trimmed body - a message that merely contains "stop" as a word,
// e.g. "please stop by tomorrow", must never match).
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
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
