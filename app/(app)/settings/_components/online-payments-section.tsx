import { CreditCard, ExternalLink } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import type { ConnectStatus } from "@/lib/payments/connect";
import { describeOnlinePayments, ONLINE_PAYMENTS_START_PATH, STATUS_REFRESH_FAILED_NOTICE, STRIPE_DASHBOARD_URL } from "@/lib/payments/online-payments-view";

/**
 * Phase 1C, Step 4: the Settings "Online payments" section - connect the
 * contractor's own Stripe account so customers can pay invoices by card.
 * Same shape as calendar-connection-section.tsx (title, one-line
 * explanation, a bordered status row with the one action). Every state and
 * word comes from lib/payments/online-payments-view.ts; this component only
 * renders it. The action is a plain form POST to the start route (it creates
 * a Stripe account, so it is never a GET link). No account id or other
 * internal identifier is rendered.
 */
export function OnlinePaymentsSection({ status, paymentStatus, canEdit, refreshFailed = false }: { status: ConnectStatus | null; paymentStatus: string; canEdit: boolean; refreshFailed?: boolean }) {
  const view = describeOnlinePayments({ status, paymentStatus, canEdit });

  return (
    <section id="online-payments">
      <h2 className={subsectionTitleClass}>Online payments</h2>
      <p className={`mt-1 ${metaClass}`}>
        Connect your own Stripe account so customers can pay invoices by card from the payment link you send them. Payments go straight to your Stripe account - Trackpr never holds the money and adds no fee. Stripe&apos;s standard card processing fees apply.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas/60 px-4 py-3.5">
        <div className="space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2.5 text-ink-2">
            <CreditCard className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            {view.badge ? <Badge tone={view.badge.tone}>{view.badge.label}</Badge> : null}
            <span>{view.message}</span>
          </div>
          {view.detail ? <p className={metaClass}>{view.detail}</p> : null}
          {refreshFailed ? <p className={metaClass}>{STATUS_REFRESH_FAILED_NOTICE}</p> : null}
        </div>

        <div className="flex items-center gap-2">
          {view.showDashboardLink ? (
            <a href={STRIPE_DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className={secondaryButtonAutoClass}>
              Stripe dashboard
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden />
            </a>
          ) : null}
          {view.action ? (
            <form method="post" action={ONLINE_PAYMENTS_START_PATH}>
              <button type="submit" className={primaryButtonAutoClass}>
                {view.action.label}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  );
}
