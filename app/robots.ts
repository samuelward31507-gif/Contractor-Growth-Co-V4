import type { MetadataRoute } from "next";

const SITE_URL = "https://contractor-growth-co-v4.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/trackpr", "/how-it-works", "/services", "/get-started", "/privacy", "/terms"],
      // The authenticated Trackpr application and its APIs are not part of
      // the public marketing site and should never be indexed.
      disallow: [
        "/today",
        "/people",
        "/money",
        "/schedule",
        "/insights",
        "/dashboard",
        "/customers",
        "/leads",
        "/contacts",
        "/work",
        "/opportunities",
        "/conversations",
        "/appointments",
        "/estimates",
        "/jobs",
        "/automations",
        "/automation-health",
        "/activity",
        "/analytics",
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
