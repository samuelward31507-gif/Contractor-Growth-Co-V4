import type { Metadata } from "next";
import Link from "next/link";
import { Container, Eyebrow } from "../_components/section";
import { TERMS_VERSION } from "@/lib/legal/terms-version";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Contractor Growth Co. collects, uses, and protects information through Trackpr.",
  alternates: { canonical: "/privacy" },
};

const h2 = "mt-12 text-xl font-semibold tracking-tight text-slate-900 first:mt-0";
const p = "mt-4 text-[15px] leading-relaxed text-slate-600";
const ul = "mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-slate-600";

export default function PrivacyPolicyPage() {
  return (
    <>
      <div className="border-b border-slate-200 bg-slate-50">
        <Container className="py-16 sm:py-20">
          <Eyebrow>Legal</Eyebrow>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Privacy Policy</h1>
          <p className="mt-3 text-[15px] text-slate-500">Effective {TERMS_VERSION}</p>
        </Container>
      </div>

      <Container className="max-w-3xl py-16 sm:py-20">
        <p className={p}>
          This Privacy Policy describes how Contractor Growth Co. (&quot;Contractor Growth Co.,&quot; &quot;we,&quot; &quot;us,&quot; or
          &quot;our&quot;) collects, uses, and protects information in connection with Trackpr, the software and managed
          service we provide to contracting businesses (each, a &quot;Contractor&quot; or &quot;you&quot;). This document describes
          our general practices. It is not a substitute for legal advice, and it has not been reviewed by outside
          counsel.
        </p>

        <h2 className={h2}>1. Information We Collect</h2>
        <p className={p}>We collect the following categories of information:</p>
        <ul className={ul}>
          <li>
            <span className="font-medium text-slate-800">Account information.</span> The email address and password
            you use to create and sign in to your Trackpr account.
          </li>
          <li>
            <span className="font-medium text-slate-800">Business/company information.</span> Information you
            provide about your business, such as your business name, owner or contact name, trade, phone number,
            service areas, business hours, and booking preferences.
          </li>
          <li>
            <span className="font-medium text-slate-800">Contact information.</span> The name, phone number, and
            email address of the customer or contact account, so we can bill and communicate with you about your
            account.
          </li>
          <li>
            <span className="font-medium text-slate-800">CRM/customer data processed through the service.</span>{" "}
            Information about your own leads and customers that you or your systems input into Trackpr - such as
            names, phone numbers, email addresses, messages, appointments, estimates, and job records - so that
            Trackpr can capture, track, and follow up on those opportunities on your behalf.
          </li>
          <li>
            <span className="font-medium text-slate-800">Usage/technical information.</span> Information about how
            you use Trackpr, such as pages visited within the application and actions taken, along with standard
            technical information (e.g. IP address, browser type) collected automatically by our hosting and
            authentication infrastructure.
          </li>
          <li>
            <span className="font-medium text-slate-800">Communications.</span> Records of messages sent and
            received through Trackpr on your behalf - including SMS messages to and from your leads and customers -
            and any messages you send to us directly (for example, support requests).
          </li>
        </ul>

        <h2 className={h2}>2. Cookies and Analytics</h2>
        <p className={p}>
          Trackpr uses only the cookies strictly necessary to keep you signed in and to operate the application
          securely (for example, an authentication session cookie). As of the effective date above, we do not use
          third-party advertising or analytics cookies. If that changes, we will update this Policy.
        </p>

        <h2 className={h2}>3. How We Use Information</h2>
        <p className={p}>We use the information described above to:</p>
        <ul className={ul}>
          <li>Provide, operate, and maintain Trackpr, including capturing, tracking, and following up on your leads;</li>
          <li>Send and receive communications (including SMS) on your behalf, using tools that may include automated and AI-assisted drafting, subject to the safeguards described in our Terms of Service;</li>
          <li>Process payment for the setup fee and ongoing Growth Management subscription;</li>
          <li>Communicate with you about your account, including service, billing, and support matters;</li>
          <li>Monitor, troubleshoot, and improve the reliability of the service; and</li>
          <li>Comply with legal obligations and enforce our Terms of Service.</li>
        </ul>

        <h2 className={h2}>4. Service Providers and Integrations</h2>
        <p className={p}>
          We use third-party service providers to operate Trackpr, including providers for database and
          authentication hosting, application hosting, payment processing, and SMS/text-messaging delivery, along
          with a workflow-automation platform used to process and dispatch messages on your behalf. These providers
          only receive the information necessary to perform their function for us and are not authorized to use it
          for their own independent purposes. We do not control, and are not responsible for, the independent privacy
          practices of these providers beyond our agreements with them.
        </p>

        <h2 className={h2}>5. Data Retention</h2>
        <p className={p}>
          We retain information for as long as your account is active and as reasonably necessary to provide
          Trackpr to you. After your account is cancelled, we may retain information for a period of time as
          necessary for legitimate business purposes, such as billing records, dispute resolution, and legal
          compliance, after which it is deleted or de-identified in the ordinary course of our data-handling
          practices.
        </p>

        <h2 className={h2}>6. Security</h2>
        <p className={p}>
          We use reasonable technical and administrative measures intended to protect information from unauthorized
          access, use, or disclosure, including encrypted connections, database-level access controls that scope
          each account to its own data, and restricted internal access to production systems. No method of storage
          or transmission is completely secure, and we cannot guarantee absolute security. We do not claim
          certification to any specific security or privacy compliance framework unless separately stated in
          writing.
        </p>

        <h2 className={h2}>7. Data Sharing</h2>
        <p className={p}>
          We do not sell your information. We share information only: (a) with the service providers described in
          Section 4, to the extent necessary to operate Trackpr; (b) as required by law, regulation, or valid legal
          process; (c) to protect the rights, property, or safety of Contractor Growth Co., our users, or others; or
          (d) in connection with a merger, acquisition, or sale of assets, subject to this Policy continuing to
          apply to the information involved.
        </p>

        <h2 className={h2}>8. Your Responsibility for the Data and Communications You Send</h2>
        <p className={p}>
          You are solely responsible for the accuracy and lawfulness of the customer and lead data you input into
          Trackpr, and for obtaining any consents required from your own customers before Trackpr sends them
          communications (including SMS) on your behalf. Trackpr provides opt-out handling (e.g. STOP/START/HELP
          keyword processing) as a technical tool, but it is not a substitute for your own compliance with
          applicable messaging, telemarketing, and privacy laws that apply to your business and your communications
          with your customers.
        </p>

        <h2 className={h2}>9. Your Rights and Requests</h2>
        <p className={p}>
          You may contact us at the address below to request access to, correction of, or deletion of the
          information associated with your account, subject to our legitimate business and legal retention
          requirements. We will respond to verified requests in a reasonable time.
        </p>

        <h2 className={h2}>10. Changes to This Policy</h2>
        <p className={p}>
          We may update this Privacy Policy from time to time. When we do, we will update the effective date above.
          Material changes will be reflected in an updated version presented at signup. Your continued use of
          Trackpr after a change becomes effective constitutes acceptance of the updated Policy.
        </p>

        <h2 className={h2}>11. Contact Us</h2>
        <p className={p}>
          Questions about this Privacy Policy can be sent to{" "}
          <a className="font-medium text-slate-900 underline-offset-4 hover:underline" href="mailto:contractorgrowthcompany@gmail.com">
            contractorgrowthcompany@gmail.com
          </a>
          .
        </p>

        <p className="mt-12 text-[13px] text-slate-400">
          See also our{" "}
          <Link href="/terms" className="underline-offset-4 hover:underline">
            Terms of Service
          </Link>
          .
        </p>
      </Container>
    </>
  );
}
