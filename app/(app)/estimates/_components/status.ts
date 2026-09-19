import { FileText, Send, CheckCircle2, XCircle, Ban, FileClock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { EstimateStatus } from "@/lib/estimates/queries";

/** Maps each estimate status onto the shared <Badge> primitive's tone + icon. */
export const ESTIMATE_STATUS_TONE: Record<EstimateStatus, BadgeTone> = {
  draft: "neutral",
  sent: "info",
  accepted: "success",
  declined: "danger",
  cancelled: "neutral",
  expired: "warning",
};

export const ESTIMATE_STATUS_ICON: Record<EstimateStatus, LucideIcon> = {
  draft: FileText,
  sent: Send,
  accepted: CheckCircle2,
  declined: XCircle,
  cancelled: Ban,
  expired: FileClock,
};
