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
 *   4. Brand hierarchy: Cinder is the company, Trackpr its flagship product;
 *      no Contractor Growth Co. marketing, and no contractor-only
 *      positioning for Cinder itself (contractors are Trackpr's live market).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(cinder)/cinder-site.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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
// Brand hierarchy (Cinder brand consolidation)
// ---------------------------------------------------------------------------

/** Every public marketing file: the site above plus the intake form, the legal pages and the error boundary. */
const PUBLIC_FILES = [...SITE_FILES, "app/(cinder)/get-started/get-started-form.tsx", "app/(cinder)/error.tsx", "app/(cinder)/privacy/page.tsx", "app/(cinder)/terms/page.tsx"];

test("brand: / identifies Cinder Revenue Company - title, social metadata, organization data and hero", () => {
  const layout = read("app/(cinder)/layout.tsx");
  assert.match(layout, /const TITLE = "Cinder Revenue Company \| Revenue Systems";/);
  assert.match(layout, /title: \{ default: TITLE, template: "%s \| Cinder Revenue Company" \}/);
  assert.match(layout, /siteName: "Cinder Revenue Company"/);
  assert.match(layout, /"@type": "Organization",\s*name: "Cinder Revenue Company",[\s\S]*brand: \{ "@type": "Brand", name: "Trackpr" \}/);
  assert.match(read("app/(cinder)/page.tsx"), /alternates: \{ canonical: "\/" \}/);
  assert.match(read("app/(cinder)/opengraph-image.tsx"), /export const alt = "Cinder Revenue Company/);
  assert.ok(COPY.includes("Revenue systems built to turn more opportunities into revenue"));
});

test("brand: /trackpr presents Trackpr as Cinder's flagship product", () => {
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
  assert.match(read("app/(cinder)/_components/footer.tsx"), /Trackpr is a product of Cinder Revenue Company\./);
});

test("brand: no Contractor Growth Co. anywhere in the Cinder marketing presentation (legal text excepted)", () => {
  // The privacy policy and terms keep their legal text as written - it names
  // the contracting entity - so only their page chrome is checked there.
  const legal = new Set(["app/(cinder)/privacy/page.tsx", "app/(cinder)/terms/page.tsx"]);
  for (const file of PUBLIC_FILES) {
    const source = read(file);
    const checked = legal.has(file) ? source.slice(0, source.indexOf("export default")) : source;
    assert.doesNotMatch(checked, /Contractor Growth/i, file);
  }
  for (const file of ["app/(cinder)/privacy/page.tsx", "app/(cinder)/terms/page.tsx"]) {
    assert.match(read(file), /Cinder Revenue Company|Eyebrow/, `${file} wears the Cinder chrome`);
  }
});

test("brand: Cinder's corporate positioning is not contractor-only - contractors appear only as Trackpr's live market", () => {
  // Corporate surfaces: no contractor language at all. The deployment's
  // hostname (SITE_URL) is an address, not copy, and is left as deployed.
  const DEPLOYMENT_HOST = "contractor-growth-co-v4.vercel.app";
  for (const file of ["app/(cinder)/layout.tsx", "app/(cinder)/page.tsx", "app/(cinder)/opengraph-image.tsx", "app/(cinder)/_components/nav.tsx", "app/(cinder)/_components/footer.tsx", "app/(cinder)/_components/lifecycle.tsx", "app/(cinder)/_components/content.ts"]) {
    assert.doesNotMatch(read(file).replaceAll(DEPLOYMENT_HOST, ""), /contractor/i, file);
  }
  // The home sections: only the Industries section names contractors (as the live market).
  const sections = read("app/(cinder)/_components/sections.tsx");
  const industries = sections.slice(sections.indexOf("export function Industries"), sections.indexOf("export function Company"));
  assert.doesNotMatch(sections.replace(industries, ""), /contractor/i, "hero, platform, Trackpr, why, company and final CTA");
  assert.match(industries, /title="Expanding into more revenue-heavy businesses\."/);
  // Future markets are named as future, never as supported.
  assert.match(read("app/(cinder)/_components/content.ts"), /FUTURE_VERTICALS = \["Gyms", "Clinics", "Med spas", "Dental", "Agencies", "Dealerships", "Other service businesses"\]/);
  assert.match(industries, /None is supported yet\./);
  assert.match(read("app/(cinder)/_components/trackpr-product.tsx"), /Trackpr does not support these yet\./);
});
