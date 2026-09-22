import type { MetadataRoute } from "next";

const SITE_URL = "https://contractor-growth-co-v4.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/how-it-works", "/services", "/get-started", "/privacy", "/terms"],
      // The authenticated Trackpr application and its APIs are not part of
      // the public marketing site and should never be indexed.
      disallow: [
        "/dashboard",
        "/leads",
        "/contacts",
        "/conversations",
        "/appointments",
        "/estimates",
        "/jobs",
        "/automations",
        "/automation-health",
        "/activity",
        "/settings",
        "/agency",
        "/onboarding",
        "/login",
        "/signup",
        "/api/",
        "/auth/",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
