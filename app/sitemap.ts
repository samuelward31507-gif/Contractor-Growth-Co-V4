import type { MetadataRoute } from "next";

const SITE_URL = "https://contractor-growth-co-v4.vercel.app";

/**
 * Only the real public marketing routes - the authenticated Trackpr app
 * (/dashboard, /leads, /agency, etc.) and API routes are intentionally
 * excluded, matching robots.ts's disallow rules for the same paths.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["/", "/how-it-works", "/services", "/get-started", "/privacy", "/terms"];
  const lastModified = new Date();

  return routes.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified,
    changeFrequency: "monthly" as const,
    priority: route === "/" ? 1 : 0.7,
  }));
}
