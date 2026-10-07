/**
 * Final Batch 4: the ONE place Trackpr decides its own public base URL.
 * Pure (reads only the env object it is given; no I/O), so it is safe to
 * import anywhere, including modules a client bundle may touch.
 *
 *   Vercel Production (VERCEL_ENV=production)
 *     APP_CANONICAL_URL, when it is a valid https origin (no path, not
 *     localhost) - lets production name its canonical domain;
 *     otherwise DEFAULT_PRODUCTION_APP_URL - the behavior before this batch,
 *     kept as the fail-safe. APP_BASE_URL and VERCEL_PROJECT_PRODUCTION_URL
 *     are deliberately NOT read in production: a 2026-09-21 incident put
 *     `http://localhost:3000` into a live email when production trusted
 *     other variables (lib/automation/sms.ts).
 *   Everything else (preview, TEST, local)
 *     APP_BASE_URL (explicit override, trailing slash stripped), then
 *     VERCEL_PROJECT_PRODUCTION_URL, else null ("not configured" - callers
 *     degrade gracefully, never guess).
 *
 * No secret is ever read here.
 */
export const DEFAULT_PRODUCTION_APP_URL = "https://contractor-growth-co-v4.vercel.app";

type Env = Record<string, string | undefined>;

/** A valid canonical origin: https, a real host (not localhost / an IP loopback), no path, query or fragment. Returns it normalized, or null. */
export function parseCanonicalOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0") return null;
  if (!host.includes(".")) return null;
  return url.origin;
}

export function resolveAppBaseUrlFromEnv(env: Env): string | null {
  if (env.VERCEL_ENV === "production") {
    return parseCanonicalOrigin(env.APP_CANONICAL_URL) ?? DEFAULT_PRODUCTION_APP_URL;
  }
  const explicit = env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelProductionUrl = env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProductionUrl) return `https://${vercelProductionUrl}`;
  return null;
}

/**
 * The public marketing site's canonical URL (metadata, robots, sitemap): the
 * production canonical origin in every environment, so a preview never
 * advertises itself to search engines.
 */
export function canonicalSiteUrl(env: Env = process.env): string {
  return parseCanonicalOrigin(env.APP_CANONICAL_URL) ?? DEFAULT_PRODUCTION_APP_URL;
}

/** True when APP_CANONICAL_URL is set but unusable (it is then ignored) - for configuration checks. */
export function isCanonicalUrlMisconfigured(env: Env = process.env): boolean {
  return Boolean(env.APP_CANONICAL_URL) && parseCanonicalOrigin(env.APP_CANONICAL_URL) === null;
}
