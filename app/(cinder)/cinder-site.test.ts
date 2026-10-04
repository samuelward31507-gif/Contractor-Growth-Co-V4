/**
 * Cinder Revenue Company website - structural guards.
 *
 *   1. Cinder owns /, the Trackpr marketing home lives at /trackpr, and both
 *      (plus their share images) stay public in the middleware.
 *   2. The brand assets the site and its metadata point at exist and are
 *      self-contained SVG (no external references, no embedded raster).
 *   3. Product truth: no invented proof - no percentages, testimonials,
 *      customer logos, prices or "AI-powered" copy anywhere on the site.
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

const SITE_FILES = ["page.tsx", "layout.tsx", "opengraph-image.tsx", ...fs.readdirSync(path.join(ROOT, "app/(cinder)/_components")).map((f) => `_components/${f}`)].map((f) => `app/(cinder)/${f}`);
const SITE = SITE_FILES.map(read).join("\n");

test("routing: Cinder is the home page, Trackpr's marketing home moved to /trackpr, and both are public", () => {
  assert.ok(exists("app/(cinder)/page.tsx"), "the Cinder home page");
  assert.ok(!exists("app/(marketing)/page.tsx"), "the Trackpr marketing home no longer claims /");
  assert.ok(exists("app/(marketing)/trackpr/page.tsx"), "the Trackpr marketing home at /trackpr");
  const middleware = read("lib/supabase/middleware.ts");
  assert.match(middleware, /new Set\(\["\/", "\/trackpr",/);
  assert.match(middleware, /if \(pathname\.startsWith\("\/opengraph-image"\) \|\| pathname\.startsWith\("\/trackpr\/opengraph-image"\)\) \{\s*return supabaseResponse;/);
  assert.match(read("app/(cinder)/_components/content.ts"), /export const TRACKPR_HREF = "\/trackpr";/);
  for (const file of ["app/robots.ts", "app/sitemap.ts"]) assert.match(read(file), /"\/", "\/trackpr"/, file);
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
  assert.equal((SITE.match(/<h1\b/g) ?? []).length, 1);
  assert.match(SITE, /href="#main"[\s\S]*Skip to content/);
  const nav = read("app/(cinder)/_components/nav.tsx");
  assert.match(nav, /aria-expanded=\{open\}\s*aria-controls="cinder-menu"/);
  assert.match(nav, /event\.key === "Escape"[\s\S]*toggleRef\.current\?\.focus\(\)/);
  assert.match(read("app/globals.css"), /@media \(prefers-reduced-motion: no-preference\) \{\s*\.cinder-reveal/);
});
