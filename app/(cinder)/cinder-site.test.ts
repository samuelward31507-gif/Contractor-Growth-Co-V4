/**
 * Cinder Revenue Company website - structural guards.
 *
 *   1. Cinder owns /, Trackpr's product page lives at /trackpr in the same
 *      Cinder site, and both (plus their share images) stay public in the
 *      middleware. The Contractor Growth Co. marketing site is gone.
 *   2. The brand assets the site and its metadata point at exist and are
 *      self-contained SVG (no external references, no embedded raster).
 *   3. Product truth: no invented proof - no percentages, testimonials,
 *      customer logos, prices or "AI-powered" copy anywhere on the site.
 *   4. Brand hierarchy: Cinder Revenue Company is the parent brand, Trackpr
 *      its flagship product, contractors and the trades Trackpr's current
 *      live vertical - never Cinder's identity. Contractor Growth Co. appears
 *      only as the legal contracting party in /privacy and /terms, whose
 *      legal text is pinned unchanged.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(cinder)/cinder-site.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));

const COMPONENTS = fs.readdirSync(path.join(ROOT, "app/(cinder)/_components")).map((f) => `_components/${f}`);
const SITE_FILES = ["page.tsx", "layout.tsx", "opengraph-image.tsx", "trackpr/page.tsx", "trackpr/opengraph-image.tsx", "get-started/page.tsx", ...COMPONENTS].map((f) => `app/(cinder)/${f}`);
const SITE = SITE_FILES.map(read).join("\n");

test("routing: Cinder is the home page, Trackpr's product page is part of the Cinder site at /trackpr, and both are public", () => {
  assert.ok(exists("app/(cinder)/page.tsx"), "the Cinder home page");
  assert.ok(exists("app/(cinder)/trackpr/page.tsx"), "the Trackpr product page at /trackpr, inside the Cinder site");
  assert.ok(exists("app/(cinder)/trackpr/opengraph-image.tsx"), "the Trackpr share card");
  assert.ok(!exists("app/(marketing)"), "the Contractor Growth Co. marketing site is retired");
  for (const page of ["get-started", "privacy", "terms"]) assert.ok(exists(`app/(cinder)/${page}/page.tsx`), `/${page} wears the Cinder layout`);
  const middleware = read("lib/supabase/middleware.ts");
  assert.match(middleware, /new Set\(\["\/", "\/trackpr",/);
  assert.match(middleware, /if \(pathname\.startsWith\("\/opengraph-image"\) \|\| pathname\.startsWith\("\/trackpr\/opengraph-image"\)\) \{\s*return supabaseResponse;/);
  assert.match(read("app/(cinder)/_components/content.ts"), /export const TRACKPR_HREF = "\/trackpr";/);
  for (const file of ["app/robots.ts", "app/sitemap.ts"]) {
    assert.match(read(file), /"\/", "\/trackpr"/, file);
    assert.doesNotMatch(read(file), /how-it-works|"\/services"/, `${file} lists only pages that render`);
  }
  assert.match(read("next.config.ts"), /\{ source: "\/how-it-works", destination: "\/trackpr", permanent: true \}/);
  assert.match(read("next.config.ts"), /\{ source: "\/services", destination: "\/trackpr", permanent: true \}/);
});

test("brand assets: every Cinder logo file exists and is a self-contained vector", () => {
  for (const name of ["cinder-mark", "cinder-mark-light", "cinder-logo", "cinder-logo-light", "cinder-logo-full", "cinder-logo-full-light", "cinder-app-icon"]) {
    const file = `public/brand/${name}.svg`;
    assert.ok(exists(file), file);
    const svg = read(file);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+" role="img"/, file);
    assert.match(svg, /<title id="t">Cinder( Revenue Company)?<\/title>/, file);
    assert.doesNotMatch(svg, /<image|<text|href=|url\(/, `${file} has no raster, live text or external reference`);
  }
  assert.match(read("app/(cinder)/layout.tsx"), /url: "\/brand\/cinder-app-icon\.svg"/);
});

// What a visitor reads: JSX text nodes and the copy strings in content.ts (not class names or CSS values).
const COPY = [...SITE.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]).join(" ") + " " + [...read("app/(cinder)/_components/content.ts").matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(" ");

test("product truth: no fabricated proof, pricing or buzzwords anywhere on the site", () => {
  assert.ok(COPY.includes("Revenue systems built to turn more opportunities into revenue"), "the copy extraction sees the hero");
  assert.doesNotMatch(COPY, /\d+\s?%|\btestimonial|\bcase stud|\bcustomers? (love|trust)|\btrusted by\b|\$\d+\s?\/\s?mo|per month|pricing/i);
  assert.doesNotMatch(COPY, /revolutioniz|unlock your potential|game-chang|cutting-edge|AI-powered|seamless|leverage|transform your business/i);
  // The only figures on the site are the Trackpr showcase's sample data, and the frame says so.
  // "sample data" is visible at every width; "Illustrative ·" joins it from sm up.
  assert.match(read("app/(cinder)/_components/trackpr-showcase.tsx"), /<span className="hidden sm:inline">Illustrative · <\/span>sample data/);
});

test("accessibility: one h1, a skip link, a labelled mobile disclosure, and motion only under no-preference", () => {
  // One h1 per page: the home hero, and the Trackpr product hero.
  const h1s = (relative: string) => (read(relative).match(/<h1\b/g) ?? []).length;
  assert.equal(h1s("app/(cinder)/_components/sections.tsx"), 1);
  assert.equal(h1s("app/(cinder)/_components/trackpr-product.tsx"), 1);
  assert.equal(h1s("app/(cinder)/trackpr/page.tsx") + h1s("app/(cinder)/page.tsx") + h1s("app/(cinder)/layout.tsx"), 0);
  assert.match(SITE, /href="#main"[\s\S]*Skip to content/);
  const nav = read("app/(cinder)/_components/nav.tsx");
  assert.match(nav, /aria-expanded=\{open\}\s*aria-controls="cinder-menu"/);
  assert.match(nav, /event\.key === "Escape"[\s\S]*toggleRef\.current\?\.focus\(\)/);
  assert.match(read("app/globals.css"), /@media \(prefers-reduced-motion: no-preference\) \{\s*\.cinder-reveal/);
});

// ---------------------------------------------------------------------------
// Brand hierarchy
//   Cinder Revenue Company (revenue technology company)
//     -> Trackpr (first flagship revenue operating system)
//       -> live today with contractors and the trades (product availability)
//       -> future revenue-heavy verticals (named as not yet supported)
// ---------------------------------------------------------------------------

const LEGAL_FILES = ["app/(cinder)/privacy/page.tsx", "app/(cinder)/terms/page.tsx"];
/** Every public marketing file other than the legal pages. */
const MARKETING_FILES = [...SITE_FILES, "app/(cinder)/get-started/get-started-form.tsx", "app/(cinder)/error.tsx", "app/robots.ts", "app/sitemap.ts"];
// The deployment's hostname is an address, not copy; it stays until the Cinder domain exists.
const DEPLOYMENT_HOST = "contractor-growth-co-v4.vercel.app";
const source = (file: string) => read(file).replaceAll(DEPLOYMENT_HOST, "");

test("brand 1: Cinder Revenue Company is the primary public brand - organization data, site name, nav, footer", () => {
  const layout = read("app/(cinder)/layout.tsx");
  assert.match(layout, /"@type": "Organization",\s*name: "Cinder Revenue Company",[\s\S]*brand: \{ "@type": "Brand", name: "Trackpr" \}/);
  assert.match(layout, /siteName: "Cinder Revenue Company"/);
  assert.match(read("app/(cinder)/_components/nav.tsx"), /aria-label="Cinder Revenue Company - home"/);
  const footer = read("app/(cinder)/_components/footer.tsx");
  assert.match(footer, /© \{new Date\(\)\.getFullYear\(\)\} Cinder Revenue Company/);
  assert.match(footer, /Trackpr is a product of Cinder Revenue Company\./);
  // Every page in the group inherits the Cinder title template.
  assert.match(layout, /title: \{ default: TITLE, template: "%s \| Cinder Revenue Company" \}/);
});

test("brand 2: / identifies Cinder as the parent company", () => {
  const layout = read("app/(cinder)/layout.tsx");
  assert.match(layout, /const TITLE = "Cinder Revenue Company \| Revenue Systems";/);
  assert.match(read("app/(cinder)/page.tsx"), /alternates: \{ canonical: "\/" \}/);
  assert.match(read("app/(cinder)/opengraph-image.tsx"), /export const alt = "Cinder Revenue Company/);
  assert.ok(COPY.includes("Revenue systems built to turn more opportunities into revenue"));
  assert.match(read("app/(cinder)/_components/sections.tsx"), /\["Flagship product", "Trackpr"\]/);
});

test("brand 3: /trackpr identifies Trackpr as Cinder's flagship product", () => {
  const page = read("app/(cinder)/trackpr/page.tsx");
  assert.match(page, /const TITLE = "Trackpr — The first revenue operating system from Cinder";/);
  assert.match(page, /title: \{ absolute: TITLE \}/);
  assert.match(page, /alternates: \{ canonical: "\/trackpr" \}/);
  assert.match(page, /siteName: "Cinder Revenue Company"/);
  assert.match(page, /publisher: \{ "@type": "Organization", name: "Cinder Revenue Company" \}/);
  const product = read("app/(cinder)/_components/trackpr-product.tsx");
  assert.match(product, /Trackpr<span className="text-cinder-accent">\.<\/span>\s*<\/h1>/);
  assert.match(product, /The first revenue operating system from Cinder\./);
  for (const question of ["What is happening with my revenue?", "What needs attention?", "What should I do next?", "Where are opportunities getting stuck?", "What is happening between lead and payment?"]) {
    assert.ok(product.includes(`q: "${question}"`), question);
  }
  assert.match(read("app/(cinder)/trackpr/opengraph-image.tsx"), /The first revenue operating system from Cinder\./);
  assert.match(read("app/(cinder)/get-started/page.tsx"), /Get started with Trackpr<span/);
});

test("brand 4: public Cinder marketing never describes Cinder as a contractor company", () => {
  // Corporate surfaces carry no contractor or trades language at all.
  for (const file of ["app/(cinder)/layout.tsx", "app/(cinder)/page.tsx", "app/(cinder)/opengraph-image.tsx", "app/(cinder)/error.tsx", "app/(cinder)/_components/nav.tsx", "app/(cinder)/_components/footer.tsx", "app/(cinder)/_components/lifecycle.tsx", "app/(cinder)/_components/content.ts", "app/robots.ts", "app/sitemap.ts"]) {
    assert.doesNotMatch(source(file), /contractor|\btrades\b/i, file);
  }
  // On the home page only the Industries section may name them, as Trackpr's live vertical.
  const sections = read("app/(cinder)/_components/sections.tsx");
  const industries = sections.slice(sections.indexOf("export function Industries"), sections.indexOf("export function Company"));
  assert.doesNotMatch(sections.replace(industries, ""), /contractor|\btrades\b/i, "hero, platform, Trackpr, why, company and final CTA");
  assert.match(industries, /title="Built for revenue-heavy businesses\."/);
  // No phrase that makes Cinder (rather than Trackpr's availability) about contractors.
  for (const file of MARKETING_FILES) {
    assert.doesNotMatch(source(file), /Cinder (builds|is|serves|helps)[^."]{0,60}contractor|built for contractors|for contractors\b|contractor-first|Contractor Growth System|Turn More Leads Into Booked Jobs/i, file);
  }
});

test("brand 5: contractor/trades language appears only where it describes Trackpr's live vertical", () => {
  // Every line of public marketing source that names contractors or the
  // trades, reviewed. A new mention fails here until it is added - and it
  // must be about Trackpr's availability, not Cinder's identity.
  const ALLOWED: Record<string, string[]> = {
    "app/(cinder)/trackpr/page.tsx": ["A product of Cinder Revenue Company, live today beginning with contractors and the trades."],
    "app/(cinder)/_components/sections.tsx": [
      'intro="Cinder builds for businesses where speed, follow-through and revenue visibility matter most. Trackpr launches with contractors and the trades."',
      'sm:text-[48px]">Contractors &amp; trades</h3>',
      "Trackpr&apos;s first live vertical — shaped around how the trades win and deliver work, from the first call to the paid invoice.",
      'aria-label="The trades lifecycle in Trackpr"',
    ],
    "app/(cinder)/_components/trackpr-product.tsx": [
      "Live today, beginning with contractors and the trades.",
      'title="Launching with the trades. Built to go further."',
      'sm:text-[40px]">Contractors and the trades</h3>',
      "Trackpr&apos;s first live vertical — shaped around how the trades win and deliver work: calls and forms, estimates, jobs and invoices.",
    ],
    "app/(cinder)/get-started/page.tsx": ["Trackpr is the first revenue operating system from Cinder, live today beginning with contractors and the trades."],
  };
  for (const file of MARKETING_FILES) {
    const mentions = source(file).split("\n").filter((line) => /contractor|\btrades\b/i.test(line.replace(/\bTRADES\b/g, ""))).map((line) => line.trim());
    const allowed = ALLOWED[file] ?? [];
    assert.equal(mentions.length, allowed.length, `${file}: ${JSON.stringify(mentions)}`);
    for (const mention of mentions) assert.ok(allowed.some((phrase) => mention.includes(phrase)), `${file}: unreviewed mention ${mention}`);
  }
});

test("brand 6: Contractor Growth Co. appears in no public marketing copy outside /privacy and /terms", () => {
  for (const file of [...MARKETING_FILES, "app/layout.tsx"]) assert.doesNotMatch(source(file), /Contractor Growth/i, file);
  // The legal pages' chrome and metadata (everything before the page body) are Cinder's too.
  for (const file of LEGAL_FILES) {
    const chrome = read(file).slice(0, read(file).indexOf("export default"));
    assert.doesNotMatch(chrome, /Contractor Growth/i, file);
  }
  assert.ok(!exists("app/(marketing)"), "the Contractor Growth Co. marketing site is retired");
});

test("brand 7: the legal pages are legally unchanged - same text, same contracting party", () => {
  // Fingerprint of every text node in each page body, whitespace-collapsed.
  // Identical to the text these pages carried before the Cinder move; a
  // legal edit must update this deliberately.
  const PINNED: Record<string, string> = {
    "app/(cinder)/privacy/page.tsx": "e6b82ed537ffa200a145065b438d11b4edca399656e2c01a52c0d732d801d6f5",
    "app/(cinder)/terms/page.tsx": "3fcf3a729f87a4b93bd8c876309a94530c6db56a53a687d472cd0de4af0b6c8d",
  };
  for (const file of LEGAL_FILES) {
    const page = read(file);
    const body = page.slice(page.indexOf("export default"));
    const text = [...body.matchAll(/>([^<>{}]+)</g)].map((m) => m[1].replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    assert.equal(crypto.createHash("sha256").update(text).digest("hex"), PINNED[file], `${file} legal text changed`);
    assert.match(body, /Contractor Growth Co\./, `${file} still names the legal contracting party`);
    assert.match(body, /mailto:contractorgrowthcompany@gmail\.com/i, `${file} keeps its legal contact`);
  }
});

test("brand 8: no invented products, integrations, customers, pricing, revenue figures or capabilities", () => {
  // Visible text nodes plus quoted strings, minus CSS values (arbitrary Tailwind values and bare sizes like "100%").
  const isCss = (value: string) => /[[\]]|^\d+(%|px)$/.test(value);
  const MARKETING_COPY = MARKETING_FILES.filter((f) => !f.endsWith("trackpr-showcase.tsx"))
    .map((f) => [...source(f).matchAll(/>([^<>{}]+)</g)].map((m) => m[1]).join(" ") + " " + [...source(f).matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((v) => !isCss(v)).join(" "))
    .join(" ");
  // Figures live only in the showcase, which is labelled sample data.
  assert.doesNotMatch(MARKETING_COPY, /\$\s?\d/, "no dollar figures outside the labelled sample showcase");
  assert.doesNotMatch(MARKETING_COPY, /\d+\s?%|\d+x\b|\btestimonial|\bcase stud|\btrusted by\b|\bcustomers? (love|trust|say)|per month|\/mo\b|pricing|free trial/i);
  // The one integration Trackpr ships is Google Calendar; no others are named.
  assert.doesNotMatch(MARKETING_COPY, /QuickBooks|Salesforce|HubSpot|Zapier|Jobber|ServiceTitan|Housecall|Outlook|Slack|Mailchimp|integrates with/i);
  // Only one product exists; future verticals are explicitly unsupported.
  assert.doesNotMatch(MARKETING_COPY, /\b(our|two|three|other|second) products\b|coming soon:/i);
  assert.match(read("app/(cinder)/_components/content.ts"), /FUTURE_VERTICALS = \["Gyms", "Clinics", "Med spas", "Dental", "Agencies", "Dealerships", "Other service businesses"\]/);
  const sections = read("app/(cinder)/_components/sections.tsx");
  assert.match(sections, /None is supported by Trackpr yet\./);
  assert.match(read("app/(cinder)/_components/trackpr-product.tsx"), /Trackpr does not support these yet\./);
});

test("positioning: Cinder's own revenue lifecycle and intake speak to any revenue-heavy business, not only the trades", () => {
  // Cinder's lifecycle (hero, problem, platform, share card) uses general
  // stages; estimates and jobs stay Trackpr's product vocabulary only.
  const content = read("app/(cinder)/_components/content.ts");
  const stages = [...content.slice(content.indexOf("export const STAGES"), content.indexOf("export const TRANSITIONS")).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(stages, ["Lead", "Response", "Qualification", "Appointment", "Proposal", "Delivery", "Payment"]);
  assert.match(read("app/(cinder)/opengraph-image.tsx"), /const STAGES = \["Lead", "Response", "Qualification", "Appointment", "Proposal", "Delivery", "Payment"\];/);
  const corporate = [content.slice(0, content.indexOf("export const TRACKPR_ANSWERS")), read("app/(cinder)/layout.tsx"), read("app/(cinder)/opengraph-image.tsx"), read("app/(cinder)/_components/lifecycle.tsx")].join("\n");
  const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.doesNotMatch(withoutComments(corporate).replaceAll(DEPLOYMENT_HOST, ""), /\bestimates?\b|\bjobs?\b|\binvoices?\b|\btrades?\b|contractor/i);
  const sections = read("app/(cinder)/_components/sections.tsx");
  const hero = sections.slice(sections.indexOf("export function Hero"), sections.indexOf("export function Platform"));
  assert.doesNotMatch(withoutComments(hero), /\bestimates?\b|\bjobs?\b|\binvoices?\b|\btrades?\b|contractor/i, "hero and problem sections");
  // The intake asks for an industry; the trade options remain (no product change).
  const form = read("app/(cinder)/get-started/get-started-form.tsx");
  assert.match(form, /Industry \{requiredMark\}/);
  assert.match(form, />\s*Select your industry\s*</);
  assert.doesNotMatch(form, /Trade \/ industry|Select your trade/);
});

test("product access: existing Trackpr users can sign in from the Cinder nav (desktop and mobile) and the Trackpr section, all via /login", () => {
  assert.match(read("app/(cinder)/_components/content.ts"), /export const SIGN_IN_HREF = "\/login";/);
  const nav = read("app/(cinder)/_components/nav.tsx");
  // Desktop: a "Sign in" link beside the marketing actions.
  assert.match(nav, /<Link href=\{SIGN_IN_HREF\}[^>]*>\s*<LogIn[^>]*\/>\s*Sign in\s*<\/Link>/);
  // Mobile sheet: closes the menu as it navigates.
  assert.match(nav, /href=\{SIGN_IN_HREF\}\s*onClick=\{\(\) => setOpen\(false\)\}[\s\S]*?Sign in to Trackpr/);
  // Trackpr section on the home page, alongside the unchanged marketing CTAs.
  const sections = read("app/(cinder)/_components/sections.tsx");
  const trackpr = sections.slice(sections.indexOf("export function Trackpr("), sections.indexOf("export function WhyCinder"));
  assert.match(trackpr, /<Link href=\{SIGN_IN_HREF\}[\s\S]*?Sign in to Trackpr\s*<\/Link>/);
  assert.match(trackpr, /Explore Trackpr[\s\S]*Try the interactive demo/);
  assert.match(nav, /See Trackpr[\s\S]*Get started/);
  // No "Talk to Cinder" email CTA anywhere on the site: the conversion path is /get-started.
  for (const file of ["nav.tsx", "sections.tsx", "trackpr-product.tsx"]) {
    const source = read(`app/(cinder)/_components/${file}`);
    assert.doesNotMatch(source, /Talk to Cinder|TALK_HREF|talkHref/, file);
  }
  assert.doesNotMatch(read("app/(cinder)/layout.tsx"), /TALK_HREF|talkHref/);
  assert.doesNotMatch(read("app/(cinder)/trackpr/page.tsx"), /TALK_HREF|talkHref/);
  assert.equal((nav.match(/<Button href=\{GET_STARTED_HREF\}/g) ?? []).length, 2, "desktop and mobile nav both lead to /get-started");
  const hero = sections.slice(sections.indexOf("export function Hero"), sections.indexOf("export function Platform"));
  assert.match(hero, /<Button href=\{GET_STARTED_HREF\} arrow size="lg">\s*Get started\s*<\/Button>/);
  assert.match(sections.slice(sections.indexOf("export function FinalCta")), /<Button href=\{GET_STARTED_HREF\} variant="inverse" arrow size="lg">\s*Get started\s*<\/Button>/);
  assert.match(read("app/(cinder)/_components/content.ts"), /export const GET_STARTED_HREF = "\/get-started";/);
  // No separate product login route on the marketing site.
  assert.ok(!exists("app/(cinder)/trackpr/login"));
});
