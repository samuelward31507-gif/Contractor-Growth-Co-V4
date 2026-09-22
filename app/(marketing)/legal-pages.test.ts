/**
 * Structural tests for Launch Blocker #3's legal pages and their wiring.
 * app/privacy/page.tsx and app/terms/page.tsx are plain Server Components
 * with no cookies()/headers() dependency, but this repo has no component-
 * rendering test infrastructure (no jsdom/@testing-library anywhere in
 * package.json) - every other "renders" claim in this codebase's test
 * suite is verified the same way used here: against the real source text.
 * The pages were also manually verified to build and route correctly via
 * `npm run build` and a local dev-server check as part of this change's
 * validation (see the accompanying report) - this file is the persisted,
 * repeatable half of that evidence.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(marketing)/legal-pages.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const PRIVACY_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(marketing)/privacy/page.tsx"), "utf8");
const TERMS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(marketing)/terms/page.tsx"), "utf8");
const FOOTER_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(marketing)/_components/marketing-footer.tsx"), "utf8");
const SITEMAP_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/sitemap.ts"), "utf8");
const PAYMENT_REQUIRED_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/onboarding/payment-required.tsx"), "utf8");

test("1. app/privacy/page.tsx exports a default component and renders an H1 reading exactly 'Privacy Policy'", () => {
  assert.match(PRIVACY_SOURCE, /export default function PrivacyPolicyPage/);
  assert.match(PRIVACY_SOURCE, /<h1[^>]*>Privacy Policy<\/h1>/);
});

test("2. app/terms/page.tsx exports a default component and renders an H1 reading exactly 'Terms of Service'", () => {
  assert.match(TERMS_SOURCE, /export default function TermsOfServicePage/);
  assert.match(TERMS_SOURCE, /<h1[^>]*>Terms of Service<\/h1>/);
});

test("3. the Privacy Policy covers every minimum required topic", () => {
  const requiredTopics = [
    "Information We Collect",
    "Cookies and Analytics",
    "How We Use Information",
    "Service Providers and Integrations",
    "Data Retention",
    "Security",
    "Data Sharing",
    "Your Responsibility for the Data and Communications You Send",
    "Your Rights and Requests",
    "Changes to This Policy",
    "Contact Us",
  ];
  for (const topic of requiredTopics) {
    assert.ok(PRIVACY_SOURCE.includes(topic), `Privacy Policy is missing required topic: "${topic}"`);
  }
});

test("4. the Terms of Service covers every minimum required topic", () => {
  const requiredTopics = [
    "Acceptance of Terms",
    "Eligibility and Account Responsibility",
    "Service Description",
    "The Contractor Growth Co. Managed-Service Relationship",
    "Access to the Software",
    "Fees",
    "Billing and Payment",
    "Cancellation",
    "Refunds",
    "Failed Payments",
    "Your Responsibilities",
    "Acceptable Use",
    "Messaging and Communications Responsibilities",
    "AI and Automation Limitations",
    "No Guarantee of Results",
    "Third-Party Services and Integrations",
    "Intellectual Property",
    "Confidentiality",
    "Data Responsibilities",
    "Limitation of Liability",
    "Indemnification",
    "Suspension and Termination",
    "Changes to the Service or These Terms",
    "Governing Law and Disputes",
    "Contact Us",
  ];
  for (const topic of requiredTopics) {
    assert.ok(TERMS_SOURCE.includes(topic), `Terms of Service is missing required topic: "${topic}"`);
  }
});

test("5. Terms of Service states the actual configured pricing ($2,500 one-time, $1,497/month) and defers to checkout for the controlling amount", () => {
  assert.match(TERMS_SOURCE, /\$2,500/);
  assert.match(TERMS_SOURCE, /\$1,497/);
  assert.match(TERMS_SOURCE, /control if they differ/);
});

test("6. neither legal page fabricates a compliance certification, street address, or invented jurisdiction", () => {
  for (const source of [PRIVACY_SOURCE, TERMS_SOURCE]) {
    assert.doesNotMatch(source, /SOC ?2|ISO ?27001|GDPR-compliant|CCPA-compliant|HIPAA/i);
  }
  assert.match(TERMS_SOURCE, /principal place of business/);
});

test("7. neither legal page exposes internal architecture (project refs, internal hostnames, specific vendor names beyond generic category descriptions)", () => {
  const bannedTerms = ["supabase", "n8n", "vercel", "twilio", "stripe", "resend", "mywznmxtlgajnczjvbmk"];
  for (const source of [PRIVACY_SOURCE, TERMS_SOURCE]) {
    for (const banned of bannedTerms) {
      assert.doesNotMatch(source.toLowerCase(), new RegExp(banned), `legal page text must not name "${banned}" - describe providers generically instead`);
    }
  }
});

test("8. the marketing footer links to both /privacy and /terms", () => {
  assert.match(FOOTER_SOURCE, /href:\s*"\/privacy"/);
  assert.match(FOOTER_SOURCE, /href:\s*"\/terms"/);
});

test("9. sitemap.ts includes /privacy and /terms", () => {
  assert.match(SITEMAP_SOURCE, /"\/privacy"/);
  assert.match(SITEMAP_SOURCE, /"\/terms"/);
});

test("10. the payment-required screen links to both /terms and /privacy as secondary reinforcement", () => {
  assert.match(PAYMENT_REQUIRED_SOURCE, /href="\/terms"/);
  assert.match(PAYMENT_REQUIRED_SOURCE, /href="\/privacy"/);
});

test("11. the payment-required screen still renders its core Complete Payment flow, unmodified by the legal-links addition", () => {
  assert.match(PAYMENT_REQUIRED_SOURCE, /Complete payment/);
  assert.match(PAYMENT_REQUIRED_SOURCE, /startCheckout/);
});
