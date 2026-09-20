/**
 * Contractor Growth Co. marketing site V1: there is no existing lead-capture
 * backend in this repository (no contact-form API route, no email service,
 * no CRM-agnostic public inbox) and this project's scope rules explicitly
 * forbid inventing one (fake email service, fake webhook, fake API
 * credentials) or touching the Supabase schema/RLS to add a public
 * inquiries table. The org-scoped `leads` table exists but is
 * RLS-protected per-tenant and has no meaning for an anonymous website
 * visitor who isn't a Trackpr customer yet.
 *
 * The honest, zero-backend option: the Get Started form composes a mailto:
 * link from the visitor's own answers and hands off to their email client -
 * nothing is silently "submitted" to a system that doesn't exist. The
 * fallback below is the real Contractor Growth Co. inbox (confirmed
 * directly by the business owner - no such address existed anywhere in
 * this repo, the environment, or the organizations table beforehand).
 * CONTACT_EMAIL in the environment still overrides it if that ever changes.
 */
export const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "ContractorGrowthCompany@gmail.com";

export function buildMailtoUrl({
  subject,
  body,
}: {
  subject: string;
  body: string;
}): string {
  const params = new URLSearchParams({ subject, body });
  return `mailto:${CONTACT_EMAIL}?${params.toString()}`;
}
