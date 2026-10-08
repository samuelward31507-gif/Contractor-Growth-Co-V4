/**
 * The customer-facing quote (app/quote/[token]): the document layout must
 * keep every behavior of the approval flow - token resolution, the demo
 * sample, the two-step approve/decline, every closed state - and show only
 * what PublicEstimate carries. This repository has no DOM test environment,
 * so the page is verified against its source, the convention the site's
 * other UI tests use.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/quote/quote-page.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const PAGE = read("app/quote/[token]/page.tsx");
const DOC = read("app/quote/[token]/_components/quote-document.tsx");
const PANEL = read("app/quote/[token]/_components/respond-panel.tsx");

test("data flow: the demo never touches the database; a real token is resolved, marked viewed only while sent, and expiry is derived as before", () => {
  assert.match(PAGE, /if \(token === "demo"\) \{\s*estimate = DEMO_ESTIMATE;/);
  assert.match(PAGE, /getEstimateByApprovalToken\(service, token\)/);
  assert.match(PAGE, /if \(estimate && estimate\.status === "sent"\) \{\s*await markApprovalViewed\(service, estimate\.id\);/);
  assert.match(PAGE, /if \(!estimate\) \{\s*return <QuoteUnavailable \/>;/);
  assert.match(PAGE, /const expired = estimate\.status === "expired" \|\| \(estimate\.status === "sent" && isPastExpiry\(estimate\)\);/);
  assert.match(PAGE, /robots: \{ index: false, follow: false \}/);
});

test("authenticity: only PublicEstimate's fields are shown - never the contractor's internal notes, and no invented pricing or terms", () => {
  assert.doesNotMatch(read("lib/estimates/approval.ts").match(/PUBLIC_ESTIMATE_COLUMNS =\s*"[^"]+"/)?.[0] ?? "", /notes/);
  assert.doesNotMatch(DOC, /\.notes\b/);
  const code = DOC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.doesNotMatch(code, /Subtotal|\bTax\b|Discount|Deposit|warranty|testimonial|review|certified|licensed|insured/i);
  // The price block is rendered only when the quote has an amount, and the total is that same amount.
  assert.match(DOC, /const amountLabel = estimate\.amount != null \? formatQuoteAmount\(estimate\.amount\) : null;/);
  assert.match(DOC, /\{amountLabel \? \(\s*<section aria-label="Price"/);
  assert.equal((DOC.match(/>\{amountLabel\}</g) ?? []).length, 2, "the line amount and the total, both the quoted figure");
  // Exact figures: cents only when the quote has them.
  assert.match(DOC, /minimumFractionDigits: hasCents \? 2 : 0/);
});

test("document structure: letterhead (business, phone, issued / valid dates, status), the work, the price with a dominant total, then the decision", () => {
  assert.match(DOC, /<header[\s\S]*\{estimate\.organizationName\}[\s\S]*href=\{`tel:\$\{estimate\.organizationPhone\}`\}/);
  assert.match(DOC, /term: "Issued"/);
  assert.match(DOC, /expired \? "Valid until" : "Valid through"/);
  assert.match(DOC, /<h1 id="quote-title"[\s\S]*\{estimate\.title\}/);
  assert.match(DOC, /<span>Description<\/span>\s*<span>Amount<\/span>/);
  assert.match(DOC, />Total<\/p>\s*<p className="font-display text-\[36px\][^"]*sm:text-\[46px\]/);
  assert.match(DOC, /This price is good until \{formatDate\(estimate\.expiresAt\)\}\./);
  assert.match(DOC, /Questions first\? Call or text \{estimate\.organizationName\} at/);
});

test("closed states keep their copy: approved, declined, withdrawn, expired and an unavailable link", () => {
  assert.match(DOC, /You approved this quote\{estimate\.respondedAt \? ` on \$\{formatDate\(estimate\.respondedAt\)\}` : ""\}\./);
  assert.match(DOC, /will be in touch to schedule the work\./);
  assert.match(DOC, /heading="You passed on this quote\."/);
  assert.match(DOC, /heading="This quote was withdrawn\."/);
  assert.match(DOC, /heading="This quote has expired\."/);
  assert.match(DOC, /heading="This quote link isn't available\."/);
  // Only an open quote offers the decision.
  assert.match(DOC, /\) : \(\s*<RespondPanel token=\{token\} organizationName=\{estimate\.organizationName\} amountLabel=\{amountLabel\} isDemo=\{isDemo\} \/>/);
  assert.match(DOC, /Sample quote — this is a demo, no real pricing\./);
});

test("approve / decline: unchanged two-step flow, request, demo short-circuit and labels", () => {
  assert.match(PANEL, /fetch\(`\/api\/quote\/\$\{encodeURIComponent\(token\)\}\/respond`, \{\s*method: "POST",/);
  assert.match(PANEL, /body: JSON\.stringify\(\{ decision \}\)/);
  assert.match(PANEL, /if \(isDemo\) \{\s*await new Promise/);
  assert.match(PANEL, /payload\?\.outcome === "already_responded"/);
  assert.match(PANEL, /router\.refresh\(\)/);
  for (const label of ["Approve this quote", "`Yes, approve${amountLabel ? ` — ${amountLabel}` : \"\"}`", "Approving…", "No thanks", "Yes — no thanks", "One sec…", "Go back", "That didn't go through. Give it another try, or just call."]) {
    assert.ok(PANEL.includes(label), label);
  }
  // Results and errors are announced to assistive technology.
  assert.match(PANEL, /role="status"/);
  assert.match(PANEL, /role="alert"/);
  // Comfortable tap targets on phones.
  assert.match(PANEL, /min-h-\[52px\]/);
  assert.match(PANEL, /min-h-\[44px\]/);
});
