import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Star, SlidersHorizontal } from "lucide-react";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { describeSystemStatus } from "../_components/system-status-model";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { StatusDot } from "@/lib/ui/status-dot";
import { cardClass } from "@/lib/ui/surface";
import { metaClass, sectionLabelClass } from "@/lib/ui/typography";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

/**
 * Batch 2 (navigation, shell & information architecture): the TRACKPR
 * destination - "what is Trackpr doing for me?" - as distinct from the
 * YOU destinations ("what needs me?"). This batch establishes the route and
 * a functional landing surface only; the outcome-first activity view ("Trackpr
 * is following up with 8 leads, 3 customers replied...") is a later batch.
 *
 * Read-only. The one data read is getOrganizationHealth - the same
 * request-cached read the top bar's status indicator already makes - and the
 * technical automation area (/automations: catalog, executions, health) and
 * Reviews & referrals (/growth) are reached from here, unchanged.
 *
 * Lives at /autopilot because /trackpr is the public Cinder product page.
 */
const HANDLES: string[] = [
  "Following up with new leads",
  "Answering customer replies",
  "Booking and confirming appointments",
  "Appointment reminders",
  "Following up on estimates",
  "Following up on unpaid invoices",
  "Bringing back past customers",
  "Asking for reviews and referrals",
  "Watching for problems and telling you",
];

export default async function TrackprPage() {
  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const health = await getOrganizationHealth(supabase, membership.organizationId).catch(() => null);
  const status = health ? describeSystemStatus(health) : null;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Trackpr" title="Trackpr" description="What Trackpr is handling for you, so you only see what needs you." />

      <Panel>
        {status ? (
          <div className="flex items-start gap-3">
            <span className="mt-1.5">
              <StatusDot tone={status.tone} />
            </span>
            <div className="min-w-0">
              <p className="text-base font-semibold text-ink">{status.headline}</p>
              <p className={`mt-1 ${metaClass}`}>{status.body}</p>
              {status.issues.length > 0 ? (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-ink-2">
                  {status.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-3">Trackpr&apos;s status is temporarily unavailable. Please try again.</p>
        )}
      </Panel>

      <section aria-labelledby="trackpr-handles">
        <h2 id="trackpr-handles" className={sectionLabelClass}>
          What Trackpr handles
        </h2>
        <ul className={`mt-3 grid gap-px overflow-hidden sm:grid-cols-2 lg:grid-cols-3 ${cardClass} bg-line`}>
          {HANDLES.map((item) => (
            <li key={item} className="bg-surface px-5 py-3.5 text-sm text-ink-2">
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="trackpr-more" className="grid gap-3 sm:grid-cols-2">
        <h2 id="trackpr-more" className="sr-only">
          More from Trackpr
        </h2>
        <TrackprLink href="/growth" icon={Star} title="Reviews & referrals" description="The review and referral requests Trackpr sends after a job." />
        <TrackprLink href="/automations" icon={SlidersHorizontal} title="Advanced" description="Every automation, its recent activity and health, and its on/off switch." />
      </section>
    </div>
  );
}

function TrackprLink({ href, icon: Icon, title, description }: { href: string; icon: typeof Star; title: string; description: string }) {
  return (
    <Link href={href} className={`group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-hover ${cardClass}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className={`mt-0.5 block ${metaClass}`}>{description}</span>
      </span>
      <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-4 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}
