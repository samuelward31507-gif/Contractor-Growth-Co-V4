/**
 * The single source of truth for the Contractor Growth Co. system sequence
 * (Attract -> Capture -> Respond -> Qualify -> Follow Up -> Book -> Close
 * -> Reactivate -> Review -> Referral -> Track). Reused by the System
 * section on the homepage and by /how-it-works so the sequence and its
 * wording never drift between the two places it's shown in full.
 */
import type { LucideIcon } from "lucide-react";
import {
  Megaphone,
  Inbox,
  Zap,
  ListChecks,
  Repeat,
  CalendarCheck2,
  FileCheck2,
  RotateCcw,
  Star,
  Share2,
  LineChart,
} from "lucide-react";

export type SystemStep = {
  key: string;
  label: string;
  shortDescription: string;
  longDescription: string;
  icon: LucideIcon;
};

export const SYSTEM_STEPS: SystemStep[] = [
  {
    key: "attract",
    label: "Attract",
    shortDescription: "Bring in inquiries through your website and existing channels.",
    longDescription:
      "Your website and existing marketing bring inquiries in - the system is built to make sure every one of them lands somewhere real instead of a missed call or an unanswered form.",
    icon: Megaphone,
  },
  {
    key: "capture",
    label: "Capture",
    shortDescription: "Turn inquiries into organized opportunities.",
    longDescription:
      "Every call, form, and message gets captured as a real opportunity instead of a voicemail or a forgotten text thread.",
    icon: Inbox,
  },
  {
    key: "respond",
    label: "Respond",
    shortDescription: "Respond quickly when a new lead comes in.",
    longDescription:
      "New opportunities get an immediate response instead of sitting untouched while a prospect calls the next contractor on their list.",
    icon: Zap,
  },
  {
    key: "qualify",
    label: "Qualify",
    shortDescription: "Identify what the customer needs.",
    longDescription:
      "Incoming conversations are reviewed so the right opportunities get surfaced instead of buried in a shared inbox.",
    icon: ListChecks,
  },
  {
    key: "follow-up",
    label: "Follow Up",
    shortDescription: "Keep conversations moving automatically.",
    longDescription: "Leads and open estimates get followed up with instead of quietly going cold.",
    icon: Repeat,
  },
  {
    key: "book",
    label: "Book",
    shortDescription: "Move qualified prospects toward an appointment.",
    longDescription: "Interested prospects are moved toward a scheduled appointment, not left to figure out the next step themselves.",
    icon: CalendarCheck2,
  },
  {
    key: "close",
    label: "Close",
    shortDescription: "Keep estimates and jobs moving to completion.",
    longDescription: "Sent estimates get tracked and followed up on, and booked work stays visible from scheduling through completion.",
    icon: FileCheck2,
  },
  {
    key: "reactivate",
    label: "Reactivate",
    shortDescription: "Reconnect with older leads and customers.",
    longDescription: "Past customers and old leads get reconnected with instead of being forgotten after the first job.",
    icon: RotateCcw,
  },
  {
    key: "review",
    label: "Review",
    shortDescription: "Create a review opportunity after the job.",
    longDescription: "A completed job automatically creates the opportunity to ask for a review while the work is still fresh.",
    icon: Star,
  },
  {
    key: "referral",
    label: "Referral",
    shortDescription: "Turn happy customers into new opportunities.",
    longDescription: "Satisfied customers get a natural opening to send new business your way, instead of that opportunity going unasked.",
    icon: Share2,
  },
  {
    key: "track",
    label: "Track",
    shortDescription: "See what's happening across the business.",
    longDescription: "Pipeline, follow-up, and job activity are visible in one place instead of scattered across texts, memory, and spreadsheets.",
    icon: LineChart,
  },
];
