/**
 * Deterministic checks on every model reply before a visitor sees it. The
 * prompt already forbids these; this is the backstop for the cases where a
 * wrong answer would be a false claim the business never made.
 */

/** The site publishes no prices and no percentages - any money figure or percentage in a reply is invented. */
// Only money and percentages: a visitor's own volume ("50 leads per month") is fine to reflect back.
const UNPUBLISHED_FIGURE = /(?:[$€£]\s?\d)|(?:\d[\d,.]*\s?(?:%|percent\b))|(?:\b\d[\d,.]*k?\s?(?:dollars|usd|bucks)\b)/i;
const URL_OR_EMAIL = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;

export const FIGURE_SAFE_REPLY =
  "Pricing and results aren't published on the site, and I don't want to guess. The Cinder team can walk through what it would look like for your business specifically.";

export type GuardResult = { reply: string; replaced: boolean };

export function guardReply(reply: string): GuardResult {
  if (UNPUBLISHED_FIGURE.test(reply)) return { reply: FIGURE_SAFE_REPLY, replaced: true };
  // Links are shown as buttons the server chooses - never as text the model wrote.
  const withoutLinks = reply.replace(URL_OR_EMAIL, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return { reply: withoutLinks, replaced: withoutLinks !== reply.trim() };
}
