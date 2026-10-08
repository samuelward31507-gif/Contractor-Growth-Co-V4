/**
 * The only destinations the assistant can point a visitor to. The model
 * chooses one of these keys (an enum in its output schema) - it never
 * writes a URL - and the server resolves the key here, so a link in the
 * chat is always a real page the site already links to.
 *
 * There is no booking calendar on the site today. "talk" is the site's own
 * "Talk to Cinder" email hand-off and "get_started" its intake page; when a
 * booking link exists, point MEETING_HREF at it and nothing else changes.
 */
import { TALK_HREF, TRACKPR_DEMO_HREF, TRACKPR_HREF } from "@/app/(cinder)/_components/content";

export const NEXT_STEP_KEYS = ["none", "get_started", "talk", "demo", "trackpr"] as const;
export type NextStepKey = (typeof NEXT_STEP_KEYS)[number];

export type NextStepLink = { key: Exclude<NextStepKey, "none">; label: string; href: string; description: string };

/** The meeting path. The intake page is the site's existing "talk to us about your business" flow. */
export const MEETING_HREF = "/get-started";

export const NEXT_STEPS: Record<Exclude<NextStepKey, "none">, NextStepLink> = {
  get_started: { key: "get_started", label: "Tell us about your business", href: MEETING_HREF, description: "The Get started page - Cinder looks at your business and shows how Trackpr would run it." },
  // The destination is the site's own "Talk to Cinder" hand-off (TALK_HREF), unchanged; only the button's wording is the chat's.
  talk: { key: "talk", label: "Talk with the Cinder team", href: TALK_HREF, description: "Reach the Cinder team directly (opens the visitor's email)." },
  demo: { key: "demo", label: "Try the interactive demo", href: TRACKPR_DEMO_HREF, description: "Click through Trackpr with sample data." },
  trackpr: { key: "trackpr", label: "Explore Trackpr", href: TRACKPR_HREF, description: "The Trackpr product page." },
};

export function resolveNextStep(key: unknown): NextStepLink | null {
  if (typeof key !== "string" || key === "none") return null;
  return Object.prototype.hasOwnProperty.call(NEXT_STEPS, key) ? NEXT_STEPS[key as Exclude<NextStepKey, "none">] : null;
}
