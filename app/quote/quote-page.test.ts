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
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("data flow: the demo never touches the database; a real token is resolved, marked viewed only while sent, and expiry is derived as before", () => {
  assert.match(PAGE, /if \(token === "demo"\) \{\s*estimate = DEMO_ESTIMATE;/);
  assert.match(PAGE, /getEstimateByApprovalToken\(service, token\)/);
  assert.match(PAGE, /if \(estimate && estimate\.status === "sent"\) \{\s*await markApprovalViewed\(service, estimate\.id\);/);
  assert.match(PAGE, /if \(!estimate\) \{\s*return <QuoteUnavailable \/>;/);
  assert.match(PAGE, /const expired = estimate\.status === "expired" \|\| \(estimate\.status === "sent" && isPastExpiry\(estimate\)\);/);
  assert.match(PAGE, /robots: \{ index: false, follow: false \}/);
});

test("authenticity: only PublicEstimate's fields are shown - never the contractor's internal notes, and nothing invented", () => {
  const approval = read("lib/estimates/approval.ts");
  const columns = approval.match(/PUBLIC_ESTIMATE_COLUMNS =\s*"[^"]+"/)?.[0] ?? "";
  assert.doesNotMatch(columns, /notes/);
  // The customer's own name is shown; their phone and email are never echoed back on the page.
  assert.match(columns, /contact:contacts\(first_name, last_name, company_name\)/);
  assert.doesNotMatch(read("lib/estimates/details.ts").match(/select\("number, scope_of_work, terms"\)/)?.[0] ?? "missing", /notes/);
  assert.doesNotMatch(DOC, /\.notes\b/);
  const code = withoutComments(DOC);
  // No tax, discount, deposit, logo or marketing claims - the schema has none of them.
  assert.doesNotMatch(code, /\bTax\b|Discount|Deposit|warranty|testimonial|review|certified|licensed|insured|logo/i);
  // The price block is rendered only when the quote has an amount, and that amount appears once, as the total.
  assert.match(DOC, /const amountLabel = estimate\.amount != null \? formatQuoteAmount\(estimate\.amount\) : null;/);
  assert.match(DOC, /\{amountLabel \? \(\s*<section aria-label="Price"/);
  assert.equal((DOC.match(/>\{amountLabel\}</g) ?? []).length, 1, "the quoted figure appears once, as the total");
  // Itemization only when the saved items add up exactly to the approved total - never two different figures.
  assert.match(DOC, /const itemized = lineItemsMatchTotal\(details\.lineItems, estimate\.amount\);/);
  assert.match(DOC, /const items = itemized \? details\.lineItems : \[\];/);
  assert.match(DOC, /\{items\.length > 0 \? \(\s*<section aria-labelledby="quote-items"/);
  // Scope and terms only when the contractor wrote them.
  assert.match(DOC, /\{details\.scopeOfWork \? \(/);
  assert.match(DOC, /\{details\.terms \? \(/);
  // Exact figures: cents only when the quote has them.
  assert.match(DOC, /minimumFractionDigits: hasCents \? 2 : 0/);
});

test("itemized layout: a table with description, quantity, unit price and line total from sm up, stacked rows on a phone, then the subtotal", () => {
  for (const heading of [">Item<", ">Qty<", ">Unit price<", ">Line total<", ">Subtotal<", ">Work and materials<"]) assert.ok(DOC.includes(heading), heading);
  assert.match(DOC, /<table className="mt-3 hidden w-full[^"]*sm:table print:table">/);
  assert.match(DOC, /<ul className="[^"]*sm:hidden print:hidden">/);
  assert.match(DOC, /formatLineMoney\(lineItemTotal\(item\)\)/);
  assert.match(DOC, /formatLineMoney\(lineItemsSubtotal\(items\)\)/);
});

test("letterhead and metadata: business contact details, quote number, customer, issued and valid-until dates - each only when set", () => {
  assert.match(DOC, /\{estimate\.organizationAddress \? </);
  assert.match(DOC, /href=\{`mailto:\$\{estimate\.organizationEmail\}`\}/);
  assert.match(DOC, /\{quoteNumber \? \(\s*<div>\s*<dt className=\{LABEL\}>Quote no\.<\/dt>/);
  assert.match(DOC, /\{customer \? \(\s*<div>\s*<dt className=\{LABEL\}>Prepared for<\/dt>/);
  assert.match(DOC, /<dt className=\{LABEL\}>Valid until<\/dt>/);
  // A website without a scheme is linked over https; nothing else becomes a link target.
  assert.match(DOC, /\/\^https\?:\\\/\\\/\/i\.test\(website\) \? website : `https:\/\/\$\{website\}`/);
});

test("print / save as PDF: a print button outside the document, and print hides the controls, banner chrome and card styling", () => {
  const PRINT = read("app/quote/[token]/_components/print-button.tsx");
  assert.match(PRINT, /onClick=\{\(\) => window\.print\(\)\}/);
  assert.match(PRINT, /print:hidden/);
  assert.match(DOC, /<QuoteFrame isDemo=\{isDemo\} toolbar=\{<PrintButton \/>\}>/);
  assert.match(DOC, /\{toolbar \? <div className="[^"]*print:hidden">/);
  assert.match(DOC, /<div className="print:hidden">\s*<RespondPanel/);
  assert.match(DOC, /print:border-0 print:shadow-none/);
  assert.match(DOC, /<footer className=\{`[^`]*print:hidden`\}>/);
});

test("document structure: letterhead (sender, phone), the quote and its work, issued date and status, a dominant total, the decision, then contact", () => {
  assert.match(DOC, /<header[\s\S]*\{estimate\.organizationName\}[\s\S]*href=\{`tel:\$\{estimate\.organizationPhone\}`\}/);
  assert.match(DOC, /<p className=\{LABEL\}>Quote<\/p>\s*<h1\s+id="quote-title"[\s\S]*?\{estimate\.title\}/);
  assert.match(DOC, /<dt className=\{LABEL\}>Issued<\/dt>[\s\S]*?formatDate\(estimate\.sentAt\)/);
  assert.match(DOC, /<dt className=\{LABEL\}>Status<\/dt>[\s\S]*?\{status\.label\}/);
  for (const label of ['"Awaiting your response"', "`Approved ${formatDate(estimate.respondedAt)}`", '"Declined"', '"Withdrawn"', '"Expired"']) {
    assert.ok(DOC.includes(label), label);
  }
  assert.match(DOC, />Total<\/p>\s*<p className="font-display text-\[38px\][^"]*sm:text-\[48px\][^"]*">\{amountLabel\}</);
  assert.match(DOC, /This price is good until \{formatDate\(estimate\.expiresAt\)\}\./);
  assert.match(DOC, /<footer[\s\S]*Questions first\? Call or text \{estimate\.organizationName\} at/);
  // Long scope titles step down a size (and a very long one reads as a paragraph) instead of a wall of headline text.
  assert.match(DOC, /estimate\.title\.length > 140/);
  assert.match(DOC, /estimate\.title\.length > 60/);
});

test("closed states keep their copy: approved, declined, withdrawn, expired and an unavailable link", () => {
  assert.match(DOC, /You approved this quote\{estimate\.respondedAt \? ` on \$\{formatDate\(estimate\.respondedAt\)\}` : ""\}\./);
  assert.match(DOC, /will be in touch to schedule the work\./);
  assert.match(DOC, /heading="You passed on this quote\."/);
  assert.match(DOC, /heading="This quote was withdrawn\."/);
  assert.match(DOC, /heading="This quote has expired\."/);
  assert.match(DOC, /heading="This quote link isn't available\."/);
  // Only an open quote offers the decision.
  assert.match(DOC, /\) : \(\s*<>\s*<div className="print:hidden">\s*<RespondPanel token=\{token\} organizationName=\{estimate\.organizationName\} amountLabel=\{amountLabel\} isDemo=\{isDemo\} \/>/);
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
  // Calm, professional decision copy.
  assert.match(PANEL, /"Your approval"/);
  // Results and errors are announced to assistive technology.
  assert.match(PANEL, /role="status"/);
  assert.match(PANEL, /role="alert"/);
  // Comfortable tap targets on phones.
  assert.match(PANEL, /min-h-\[52px\]/);
  assert.match(PANEL, /min-h-\[44px\]/);
});

test("contractor editor: line items, scope and terms are editable only on a draft, and hidden when the database lacks them", () => {
  const PAGE_DETAIL = read("app/(app)/estimates/[id]/page.tsx");
  const EDITOR = read("app/(app)/estimates/[id]/_components/quote-details-editor.tsx");
  const ACTIONS = read("app/(app)/estimates/quote-details-actions.ts");
  // Keyed by the saved scope/terms, so an edit made in the Edit Estimate dialog remounts the editor with fresh values (no stale overwrite).
  assert.match(PAGE_DETAIL, /<QuoteDetailsEditor key=\{`\$\{details\.scopeOfWork \?\? ""\}\\u0000\$\{details\.terms \?\? ""\}`\} estimateId=\{estimate\.id\} editable=\{estimate\.status === "draft"\} details=\{details\} amount=\{estimate\.amount\} \/>/);
  assert.match(PAGE_DETAIL, /getEstimateDetails\(supabase, membership\.organizationId, id\)/);
  assert.match(EDITOR, /!details\.lineItemsAvailable \? \(/);
  assert.match(EDITOR, /if \(!details\.textFieldsAvailable\) return null;/);
  assert.match(EDITOR, /editable && details\.lineItemsAvailable && editingId === null/);
  // Every server action re-checks the draft state in the caller's organization.
  assert.equal((ACTIONS.match(/await requireDraft\(supabase, organizationId, estimateId\)/g) ?? []).length, 4);
  assert.match(ACTIONS, /\.eq\("organization_id", organizationId\)\.eq\("status", "draft"\)/);
  // Internal notes are never part of the customer-facing editor.
  assert.doesNotMatch(EDITOR, /\.notes\b|notes:/);
});
