import Link from "next/link";
import { CheckCircle2, AlertTriangle, Circle } from "lucide-react";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import type { AgencyClientReadiness } from "@/lib/agency/expansion";
import type { ReadinessItem } from "@/lib/onboarding/readiness";

/** Short renderings of the exact same lib/onboarding/readiness.ts keys/labels - not new semantics, just compact enough for a per-client badge row. */
const READINESS_KEY_LABEL: Record<ReadinessItem["key"], string> = {
  business: "Business",
  hours: "Hours",
  leadCapture: "Lead Capture",
  sms: "Phone/SMS",
  ai: "AI",
  booking: "Booking",
  calendar: "Calendar",
};

/** Mirrors app/agency/organizations/[id]/page.tsx's own readinessStateLabel/tone treatment exactly - the same three-state vocabulary (ready / not_ready / disabled_by_intent), never collapsed to a plain boolean and never claiming a state (e.g. "Connected") the underlying system doesn't actually verify. */
const STATE_TONE: Record<ReadinessItem["state"], BadgeTone> = {
  ready: "success",
  not_ready: "warning",
  disabled_by_intent: "neutral",
};

const STATE_ICON: Record<ReadinessItem["state"], typeof CheckCircle2> = {
  ready: CheckCircle2,
  not_ready: AlertTriangle,
  disabled_by_intent: Circle,
};

/** Agency redesign: the state each badge's color and icon show, spoken for screen readers (the visible badge text is only the area name) - the same words as the client detail page's readinessStateLabel. */
const STATE_SR_LABEL: Record<ReadinessItem["state"], string> = {
  ready: "ready",
  not_ready: "not ready",
  disabled_by_intent: "off by choice",
};

export function ClientReadinessRow({ client }: { client: AgencyClientReadiness }) {
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <Link href={`/agency/organizations/${client.organizationId}`} className="min-w-0 shrink-0 break-words text-sm font-medium text-ink hover:underline">
        {client.organizationName}
      </Link>
      <div className="flex flex-wrap gap-1.5 sm:justify-end">
        {client.readiness.items.map((item) => (
          <Badge key={item.key} tone={STATE_TONE[item.state]} icon={STATE_ICON[item.state]}>
            {READINESS_KEY_LABEL[item.key]}
            <span className="sr-only">: {STATE_SR_LABEL[item.state]}</span>
          </Badge>
        ))}
      </div>
    </li>
  );
}
