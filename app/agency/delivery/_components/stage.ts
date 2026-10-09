import type { BadgeTone } from "@/lib/ui/badge";
import type { LifecycleStatus, ReadinessCheckStatus } from "@/lib/agency/delivery";

export const STAGE_TONE: Record<LifecycleStatus, BadgeTone> = {
  onboarding_not_started: "neutral",
  onboarding: "info",
  ready_to_launch: "warning",
  live: "success",
  ongoing_management: "success",
};

export const CHECK_TONE: Record<ReadinessCheckStatus, BadgeTone> = { passed: "success", failed: "danger", unverified: "neutral" };
export const CHECK_LABEL: Record<ReadinessCheckStatus, string> = { passed: "Passed", failed: "Failed", unverified: "Unverified" };

export const DELIVERY_TZ = "America/Denver";
export const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: DELIVERY_TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
