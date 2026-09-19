import { CalendarClock, Hammer, CheckCircle2, Ban, Send, MessageCircle, Trophy, AlertTriangle, CircleSlash } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { JobStatus } from "@/lib/jobs/queries";
import type { ReviewRequestStatus, ReferralRequestStatus } from "@/lib/reviews-referrals/queries";

/** Maps each job status onto the shared <Badge> primitive's tone + icon. */
export const JOB_STATUS_TONE: Record<JobStatus, BadgeTone> = {
  scheduled: "info",
  in_progress: "warning",
  completed: "success",
  cancelled: "neutral",
};

export const JOB_STATUS_ICON: Record<JobStatus, LucideIcon> = {
  scheduled: CalendarClock,
  in_progress: Hammer,
  completed: CheckCircle2,
  cancelled: Ban,
};

/**
 * Review/referral requests share one lifecycle shape (not_requested ->
 * requested -> responded -> a terminal outcome), so both status enums map
 * onto the same tone logic: requested is informational, responded is an
 * amber "waiting on their decision", the positive terminal outcome
 * (completed/converted) is success, declined recedes to neutral (their
 * choice, not a failure of the system), and failed - the automation itself
 * breaking - is the one danger state.
 */
export const REVIEW_STATUS_TONE: Record<ReviewRequestStatus, BadgeTone> = {
  not_requested: "neutral",
  requested: "info",
  responded: "warning",
  completed: "success",
  declined: "neutral",
  failed: "danger",
};

export const REVIEW_STATUS_ICON: Record<ReviewRequestStatus, LucideIcon> = {
  not_requested: CircleSlash,
  requested: Send,
  responded: MessageCircle,
  completed: Trophy,
  declined: Ban,
  failed: AlertTriangle,
};

export const REFERRAL_STATUS_TONE: Record<ReferralRequestStatus, BadgeTone> = {
  not_requested: "neutral",
  requested: "info",
  responded: "warning",
  converted: "success",
  declined: "neutral",
  failed: "danger",
};

export const REFERRAL_STATUS_ICON: Record<ReferralRequestStatus, LucideIcon> = {
  not_requested: CircleSlash,
  requested: Send,
  responded: MessageCircle,
  converted: Trophy,
  declined: Ban,
  failed: AlertTriangle,
};
