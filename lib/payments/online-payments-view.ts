import type { BadgeTone } from "@/lib/ui/badge";
import { canAcceptOnlinePayments, describeConnectState, type ConnectStatus } from "./connect";

/**
 * Phase 1C, Step 4: what the Settings "Online payments" section shows, as a
 * pure function of the stored Connect status, the organization's Trackpr
 * subscription status and the viewer's role - unit-tested in
 * online-payments-view.test.ts. The component only renders this.
 *
 * "Accepting card payments" is shown only when canAcceptOnlinePayments is
 * true - the same rule the pay page and Checkout Session creation use
 * (charges enabled AND subscription active) - so Settings can never claim
 * customers can pay when they can't.
 */

export const ONLINE_PAYMENTS_START_PATH = "/api/payments/connect/start";
export const STRIPE_DASHBOARD_URL = "https://dashboard.stripe.com";

/** Shown when the Settings backstop couldn't reach Stripe: fixed text, never the Stripe error. */
export const STATUS_REFRESH_FAILED_NOTICE = "We couldn't check Stripe just now, so this shows the last known status.";

export type OnlinePaymentsState = "not_connected" | "onboarding_incomplete" | "accepting" | "paused";

export type OnlinePaymentsView = {
  state: OnlinePaymentsState;
  badge: { tone: BadgeTone; label: string } | null;
  message: string;
  /** Present only for owners/admins who can act. */
  action: { label: "Connect Stripe" | "Finish setup" } | null;
  detail: string | null;
  showDashboardLink: boolean;
};

export function describeOnlinePayments(input: { status: Pick<ConnectStatus, "accountId" | "chargesEnabled" | "payoutsEnabled"> | null; paymentStatus: string | null | undefined; canEdit: boolean }): OnlinePaymentsView {
  const status = input.status ?? { accountId: null, chargesEnabled: false, payoutsEnabled: false };
  const connectState = describeConnectState(status);

  if (connectState === "not_connected") {
    return {
      state: "not_connected",
      badge: null,
      message: "Stripe isn't connected yet.",
      action: input.canEdit ? { label: "Connect Stripe" } : null,
      detail: input.canEdit ? null : "Only owners and admins can connect Stripe.",
      showDashboardLink: false,
    };
  }

  if (connectState === "onboarding_incomplete") {
    return {
      state: "onboarding_incomplete",
      badge: { tone: "warning", label: "Setup incomplete" },
      message: "Stripe needs a few more details before you can accept card payments.",
      action: input.canEdit ? { label: "Finish setup" } : null,
      detail: input.canEdit ? null : "Only owners and admins can finish Stripe setup.",
      showDashboardLink: false,
    };
  }

  const payoutsDetail = status.payoutsEnabled ? null : "Payouts aren't enabled yet - Stripe will ask for your bank details before sending your money.";

  if (!canAcceptOnlinePayments({ paymentStatus: input.paymentStatus, connect: status })) {
    return {
      state: "paused",
      badge: { tone: "warning", label: "Paused" },
      message: "Card payments are paused while your Trackpr subscription is inactive.",
      action: null,
      detail: payoutsDetail,
      showDashboardLink: true,
    };
  }

  return {
    state: "accepting",
    badge: { tone: "success", label: "Accepting card payments" },
    message: "Customers can pay your invoices by card from the payment link.",
    action: null,
    detail: payoutsDetail,
    showDashboardLink: true,
  };
}

export type OnlinePaymentsBanner = { tone: "success" | "info" | "error"; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  invalid_request: "That request couldn't be verified. Please use the button in Settings to connect Stripe.",
  not_authorized: "Only owners and admins can connect Stripe.",
  subscription_inactive: "Your Trackpr subscription needs to be active to set up online payments.",
  stripe_unavailable: "We couldn't reach Stripe. Please try again.",
  not_connected: "Stripe hasn't been connected yet. Use Connect Stripe to start.",
  sync_failed: "We couldn't confirm your Stripe account status. Please try again.",
};

/** The one-time notice after returning from the Connect routes. Only fixed vocabulary is ever rendered - never the raw query string. */
export function onlinePaymentsBanner(params: Record<string, string | string[] | undefined>): OnlinePaymentsBanner | null {
  const notice = typeof params.payments === "string" ? params.payments : null;
  if (notice === "connected") return { tone: "success", message: "Stripe is connected. Customers can now pay your invoices by card." };
  if (notice === "incomplete") return { tone: "info", message: "Stripe setup isn't finished yet. Use Finish setup to continue where you left off." };
  if (notice === "expired") return { tone: "info", message: "That Stripe setup link expired. Use Finish setup to get a new one." };
  if (notice === "error") {
    const reason = typeof params.reason === "string" ? params.reason : "";
    return { tone: "error", message: ERROR_MESSAGES[reason] ?? "We couldn't connect Stripe. Please try again." };
  }
  return null;
}
