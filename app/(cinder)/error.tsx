"use client";

import { RouteError } from "@/lib/ui/route-error";

/** Error boundary for the public Cinder site (home, Trackpr, intake and legal pages). */
export default function CinderError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} homeHref="/" homeLabel="Back to Cinder" />;
}
