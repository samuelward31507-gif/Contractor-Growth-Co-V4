import { resolveAppBaseUrl } from "@/lib/automation/sms";

/**
 * Base URL for a customer-facing record link (the estimate approval page,
 * app/quote/[token]) - a link that only resolves against the SAME database
 * as the deployment that issued it.
 *
 * Production: always resolveAppBaseUrl()'s canonical URL, unchanged.
 * Preview: the preview itself (Vercel's stable branch URL, else this
 * deployment's URL, else the request's own host). resolveAppBaseUrl()
 * deliberately never returns a preview URL - right for auth emails, but a
 * Preview's estimate token lives in the TEST database, so a production-host
 * approval link issued from a Preview could never be opened.
 */
export function resolveCustomerLinkBaseUrl(requestHost: string | null = null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.VERCEL_ENV === "preview") {
    const host = env.VERCEL_BRANCH_URL || env.VERCEL_URL || requestHost;
    if (host) return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  }
  return resolveAppBaseUrl();
}

export function buildEstimateApprovalUrl(baseUrl: string, approvalToken: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/quote/${encodeURIComponent(approvalToken)}`;
}
