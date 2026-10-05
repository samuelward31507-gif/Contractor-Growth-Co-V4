/**
 * Cinder Revenue Company website - copy and structure in one place.
 *
 * Product truth: every Trackpr reference below names something the
 * Trackpr application in this repository actually does (Today's acts,
 * Inbox, Schedule, Money, Opportunities, Automations, online invoice
 * payment, reviews and referrals). No customers, results, prices or
 * integrations are claimed anywhere on the site.
 */
import { CONTACT_EMAIL } from "@/lib/site/contact";

export const SITE_URL = "https://contractor-growth-co-v4.vercel.app";
export const TRACKPR_HREF = "/trackpr";
export const TRACKPR_DEMO_HREF = "/demo";
export const TALK_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Talk to Cinder")}`;

export const NAV_LINKS = [
  { href: "/#platform", label: "Platform" },
  { href: "/#trackpr", label: "Trackpr" },
  { href: "/#industries", label: "Industries" },
  { href: "/#company", label: "Company" },
] as const;

export type Stage = {
  key: string;
  label: string;
  /** What the stage is, in the visitor's words (problem section). */
  question: string;
  /** How revenue quietly slips at this stage (problem section). */
  leak: string;
  /** The state a connected system makes visible (hero). */
  state: string;
  /** Where follow-through most often decides the outcome (hero highlight). */
  pivotal?: boolean;
};

export const STAGES: Stage[] = [
  { key: "lead", label: "Lead", question: "Someone reaches out.", leak: "A missed call. A form no one opened.", state: "Captured" },
  { key: "response", label: "Response", question: "Did someone respond?", leak: "The reply comes a day late, or never.", state: "Answered", pivotal: true },
  { key: "qualification", label: "Qualification", question: "Is this actually an opportunity?", leak: "Good fits and poor fits get the same attention.", state: "Qualified" },
  { key: "appointment", label: "Appointment", question: "Did they book?", leak: "Interest that never turns into a time.", state: "Booked" },
  { key: "estimate", label: "Estimate", question: "Was the opportunity priced?", leak: "Sent once. Never followed up.", state: "Priced", pivotal: true },
  { key: "job", label: "Job", question: "Did it become work?", leak: "Accepted, then never scheduled.", state: "Scheduled" },
  { key: "payment", label: "Payment", question: "Did the business actually get paid?", leak: "Invoiced, then forgotten.", state: "Paid", pivotal: true },
];

/**
 * The transitions where follow-through decides the outcome - the hand-offs
 * between stages, not the stages themselves. `after` is the index of the
 * stage the transition leaves.
 */
export const TRANSITIONS = [
  { after: 0, label: "First reply" },
  { after: 4, label: "Follow-up" },
  { after: 5, label: "Collection" },
] as const;

/** The illustrative record in the hero instrument: stages before it are done, it is in progress, the rest are next. */
export const ACTIVE_STAGE = 4;

export const PILLARS = [
  { key: "capture", name: "Capture", line: "Bring opportunities into one system.", stages: ["Lead"] },
  { key: "engage", name: "Engage", line: "Respond and follow up consistently.", stages: ["Response", "Qualification"] },
  { key: "convert", name: "Convert", line: "Move qualified opportunities toward revenue.", stages: ["Appointment", "Estimate"] },
  { key: "operate", name: "Operate", line: "Coordinate the work that follows.", stages: ["Job", "Payment"] },
  { key: "grow", name: "Grow", line: "Turn operational data into better decisions.", stages: ["Every stage"] },
] as const;

/** Trackpr answers - each mapped to the real area of the product that answers it. */
export const TRACKPR_ANSWERS = [
  { question: "What happened", area: "Today", detail: "New leads, appointments and replies, the moment the day starts." },
  { question: "What needs attention", area: "Needs your attention", detail: "One prioritized list, most time-sensitive first." },
  { question: "What's happening now", area: "Inbox · Schedule", detail: "Every conversation and every appointment in one place." },
  { question: "Where opportunities exist", area: "Opportunities", detail: "Customers to win back, reviews and referrals to ask for." },
  { question: "What revenue is moving", area: "Money", detail: "Quotes out, accepted work, jobs in progress, unpaid invoices." },
  { question: "What should happen next", area: "Next action", detail: "Every item carries the step that moves it forward." },
] as const;

export const WHY = [
  { key: "see", title: "See", line: "Understand what is happening across the revenue lifecycle." },
  { key: "act", title: "Act", line: "Know what needs attention and what happens next." },
  { key: "improve", title: "Improve", line: "Use real operational data to identify where revenue is being lost." },
] as const;

export const FUTURE_VERTICALS = ["Gyms", "Clinics", "Med spas", "Dental", "Agencies", "Dealerships", "Other service businesses"] as const;
