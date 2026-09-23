import { redirect } from "next/navigation";

/**
 * V2 foundation: this route was renamed to /analytics (matching the
 * "Analytics" label it has always had in the nav - see nav-items.ts).
 * Kept as a redirect, not deleted, so any bookmarked or externally-linked
 * /activity URL keeps working instead of 404ing.
 */
export default async function LegacyActivityRedirect({ searchParams }: PageProps<"/activity">) {
  const params = await searchParams;
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") nextParams.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) nextParams.set(key, value[0]);
  }
  const query = nextParams.toString();
  redirect(query ? `/analytics?${query}` : "/analytics");
}
