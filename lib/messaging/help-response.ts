export type HelpResponseOrganization = {
  name: string;
  phone: string | null;
  email: string | null;
};

/**
 * Builds the deterministic reply to an inbound HELP/INFO keyword. This is
 * intentionally NOT an AI-generated message - HELP is a carrier-style
 * compliance keyword (see lib/messaging/keywords.ts), not conversational
 * content, and the caller (app/api/webhooks/sms/inbound/route.ts) must
 * never route it through customer.message.received/AI qualification. The
 * only facts used are the organization's own already-configured name/phone/
 * email (organizations.phone/email, set via the business profile settings
 * this codebase already has) - never an invented phone number or claim
 * about the business Trackpr doesn't actually know. This function makes no
 * claim of carrier/TCPA compliance on its own; it is one input to that, not
 * a substitute for it.
 */
export function buildHelpResponseMessage(organization: HelpResponseOrganization): string {
  const contactLine = organization.phone
    ? `Contact us at ${organization.phone}.`
    : organization.email
      ? `Contact us at ${organization.email}.`
      : "We'll follow up with you directly.";

  return `${organization.name}: ${contactLine} Msg & data rates may apply. Reply STOP to unsubscribe.`;
}
