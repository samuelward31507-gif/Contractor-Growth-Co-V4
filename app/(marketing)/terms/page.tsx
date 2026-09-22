import type { Metadata } from "next";
import Link from "next/link";
import { Container, Eyebrow } from "../_components/section";
import { TERMS_VERSION } from "@/lib/legal/terms-version";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of Trackpr and the Contractor Growth Co. managed service.",
  alternates: { canonical: "/terms" },
};

const h2 = "mt-12 text-xl font-semibold tracking-tight text-slate-900 first:mt-0";
const p = "mt-4 text-[15px] leading-relaxed text-slate-600";
const ul = "mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-slate-600";

export default function TermsOfServicePage() {
  return (
    <>
      <div className="border-b border-slate-200 bg-slate-50">
        <Container className="py-16 sm:py-20">
          <Eyebrow>Legal</Eyebrow>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Terms of Service</h1>
          <p className="mt-3 text-[15px] text-slate-500">Effective {TERMS_VERSION}</p>
        </Container>
      </div>

      <Container className="max-w-3xl py-16 sm:py-20">
        <h2 className={h2}>1. Acceptance of Terms</h2>
        <p className={p}>
          By creating an account, you agree to these Terms of Service (&quot;Terms&quot;) and acknowledge our{" "}
          <Link href="/privacy" className="font-medium text-slate-900 underline-offset-4 hover:underline">
            Privacy Policy
          </Link>
          . If you do not agree, do not create an account or use Trackpr. These Terms govern the relationship
          between Contractor Growth Co. (&quot;Contractor Growth Co.,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) and the
          contracting business creating the account (&quot;Contractor,&quot; &quot;you,&quot; or &quot;your&quot;). This document describes
          our general business terms. It is not a substitute for legal advice, and it has not been reviewed by
          outside counsel.
        </p>

        <h2 className={h2}>2. Eligibility and Account Responsibility</h2>
        <p className={p}>
          You must be authorized to bind the business you represent to these Terms. You are responsible for
          maintaining the confidentiality of your account credentials and for all activity that occurs under your
          account.
        </p>

        <h2 className={h2}>3. Service Description</h2>
        <p className={p}>
          Trackpr is software, combined with an ongoing managed service provided by Contractor Growth Co., that
          captures, tracks, and helps you follow up with leads and customers for your contracting business,
          including automated and AI-assisted messaging tools, appointment and estimate tracking, and related
          workflow automation.
        </p>

        <h2 className={h2}>4. The Contractor Growth Co. Managed-Service Relationship</h2>
        <p className={p}>
          Unlike off-the-shelf software you configure entirely yourself, Trackpr is built, configured, and managed
          on an ongoing basis by Contractor Growth Co. as part of the service you are paying for. We may make
          configuration changes, updates, and improvements to the system on your behalf as part of that managed
          relationship.
        </p>

        <h2 className={h2}>5. Access to the Software</h2>
        <p className={p}>
          Subject to these Terms and payment of applicable fees, we grant you a non-exclusive, non-transferable
          right to access and use Trackpr for your own internal business purposes for as long as your account
          remains active and in good standing. You may not resell, sublicense, or provide access to Trackpr to any
          third party outside your own business.
        </p>

        <h2 className={h2}>6. Fees</h2>
        <p className={p}>The commercial terms currently offered are:</p>
        <ul className={ul}>
          <li>A one-time implementation/setup fee of $2,500; and</li>
          <li>A recurring Growth Management fee of $1,497 per month.</li>
        </ul>
        <p className={p}>
          The exact fees, billing frequency, and terms presented to you during checkout or in an order confirmation
          control if they differ from the general description on our website or in this document.
        </p>

        <h2 className={h2}>7. Billing and Payment</h2>
        <p className={p}>
          Payment is processed by our third-party payment processor. By providing payment information, you
          authorize us to charge the setup fee and to charge the recurring Growth Management fee on an ongoing
          basis until your account is cancelled in accordance with Section 8. You are responsible for keeping your
          payment method current and valid.
        </p>

        <h2 className={h2}>8. Cancellation</h2>
        <p className={p}>
          You may request cancellation of the recurring Growth Management subscription at any time by contacting us
          at the address in Section 20. Cancellation stops future recurring charges; it does not retroactively
          refund fees already charged, except as described in Section 9. Access to Trackpr may end at the close of
          the billing period in which cancellation is processed.
        </p>

        <h2 className={h2}>9. Refunds</h2>
        <p className={p}>
          The one-time implementation/setup fee compensates work already performed to build and configure your
          system and, except where required by law or as otherwise stated in an order confirmation, is
          non-refundable once that work has begun. Refund requests for the recurring Growth Management fee are
          evaluated on a case-by-case basis; contact us at the address in Section 20 to make a request.
        </p>

        <h2 className={h2}>10. Failed Payments</h2>
        <p className={p}>
          If a payment fails, we may retry the charge, suspend access to Trackpr, or both, until a valid payment is
          received. We will make reasonable efforts to notify you of a failed payment before suspending access.
        </p>

        <h2 className={h2}>11. Your Responsibilities</h2>
        <p className={p}>
          You are responsible for: the accuracy and lawfulness of the business, lead, and customer information you
          input into Trackpr; obtaining any consents required from your own customers before we send communications
          on your behalf; and your own compliance with laws applicable to your business, including telemarketing,
          messaging, and consumer-protection laws.
        </p>

        <h2 className={h2}>12. Acceptable Use</h2>
        <p className={p}>You will not use Trackpr to:</p>
        <ul className={ul}>
          <li>Send unlawful, deceptive, harassing, or unsolicited messages to any person who has not agreed to receive them;</li>
          <li>Upload or process data you do not have the right to use;</li>
          <li>Attempt to interfere with, disrupt, or gain unauthorized access to Trackpr or its underlying systems; or</li>
          <li>Use Trackpr in a manner that violates applicable law.</li>
        </ul>

        <h2 className={h2}>13. Messaging and Communications Responsibilities</h2>
        <p className={p}>
          Trackpr includes technical tools intended to support responsible messaging - such as processing STOP,
          START, and HELP keywords and honoring opt-outs on future sends - but these tools are not a substitute for
          your own compliance obligations. You remain responsible for ensuring your use of Trackpr&apos;s messaging
          features complies with applicable law, including obtaining any required consent before your customers are
          contacted.
        </p>

        <h2 className={h2}>14. AI and Automation Limitations</h2>
        <p className={p}>
          Some communications and workflow steps within Trackpr may be drafted or handled with the assistance of
          automated or AI-based tools. These tools are provided as productivity aids and are not guaranteed to be
          error-free, and Contractor Growth Co. does not guarantee that automated or AI-assisted output will always
          be accurate, appropriate, or free of mistakes. You are responsible for reviewing automation configuration
          relevant to your business and for any communication sent on your behalf, and Trackpr provides settings to
          disable AI-assisted messaging for your account.
        </p>

        <h2 className={h2}>15. No Guarantee of Results</h2>
        <p className={p}>
          Trackpr is a tool and managed service intended to help you capture, track, and follow up on
          opportunities. We do not guarantee any specific amount of revenue, leads, appointments, jobs, or other
          business results from your use of Trackpr. Business outcomes depend on many factors outside our control.
        </p>

        <h2 className={h2}>16. Third-Party Services and Integrations</h2>
        <p className={p}>
          Trackpr relies on third-party services (including payment processing, SMS/text-message delivery, and
          workflow automation) to operate. We are not responsible for outages, errors, or changes in those
          third-party services that are outside our reasonable control.
        </p>

        <h2 className={h2}>17. Intellectual Property</h2>
        <p className={p}>
          Trackpr, including its software, design, and underlying technology, is owned by Contractor Growth Co. or
          our licensors. These Terms do not transfer any ownership of Trackpr to you. You retain ownership of the
          business, lead, and customer data you input into Trackpr.
        </p>

        <h2 className={h2}>18. Confidentiality</h2>
        <p className={p}>
          Each party will use reasonable care to protect non-public information disclosed by the other party in
          connection with the service and will not disclose it to third parties except as necessary to perform its
          obligations, as permitted under our Privacy Policy, or as required by law.
        </p>

        <h2 className={h2}>19. Data Responsibilities</h2>
        <p className={p}>
          As between you and Contractor Growth Co., you are responsible for the accuracy, legality, and
          appropriateness of the data you input into Trackpr. We process that data to provide the service as
          described in our{" "}
          <Link href="/privacy" className="font-medium text-slate-900 underline-offset-4 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>

        <h2 className={h2}>20. Limitation of Liability</h2>
        <p className={p}>
          To the maximum extent permitted by law, Contractor Growth Co. will not be liable for any indirect,
          incidental, special, consequential, or punitive damages, or for any loss of revenue, profits, or
          business opportunities, arising out of or related to your use of Trackpr, even if advised of the
          possibility of such damages. To the maximum extent permitted by law, our total liability arising out of
          or related to these Terms or Trackpr will not exceed the amount you paid to us in the twelve (12) months
          before the claim arose.
        </p>

        <h2 className={h2}>21. Indemnification</h2>
        <p className={p}>
          You agree to indemnify and hold Contractor Growth Co. harmless from any claims, damages, liabilities, and
          expenses (including reasonable attorneys&apos; fees) arising from: your data; your use of Trackpr in
          violation of these Terms or applicable law; or your failure to obtain any consent required from your own
          customers before communications are sent to them on your behalf.
        </p>

        <h2 className={h2}>22. Suspension and Termination</h2>
        <p className={p}>
          We may suspend or terminate your access to Trackpr if you fail to pay applicable fees, materially breach
          these Terms, or use Trackpr in a way that creates legal or security risk for Contractor Growth Co. or
          others. You may stop using Trackpr and request cancellation as described in Section 8 at any time.
        </p>

        <h2 className={h2}>23. Changes to the Service or These Terms</h2>
        <p className={p}>
          We may update Trackpr and these Terms from time to time. When we update these Terms, we will update the
          effective date above, and material changes will be reflected in an updated version presented at signup.
          Your continued use of Trackpr after a change becomes effective constitutes acceptance of the updated
          Terms.
        </p>

        <h2 className={h2}>24. Governing Law and Disputes</h2>
        <p className={p}>
          These Terms are governed by the laws applicable to Contractor Growth Co.&apos;s principal place of business,
          without regard to conflict-of-law principles, except to the extent a different governing law is required
          by applicable consumer-protection law. Any dispute arising out of these Terms will be resolved through
          good-faith negotiation in the first instance.
        </p>

        <h2 className={h2}>25. Contact Us</h2>
        <p className={p}>
          Questions about these Terms, billing, or cancellation can be sent to{" "}
          <a className="font-medium text-slate-900 underline-offset-4 hover:underline" href="mailto:contractorgrowthcompany@gmail.com">
            contractorgrowthcompany@gmail.com
          </a>
          .
        </p>

        <p className="mt-12 text-[13px] text-slate-400">
          See also our{" "}
          <Link href="/privacy" className="underline-offset-4 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Container>
    </>
  );
}
