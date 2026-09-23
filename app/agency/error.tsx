"use client";

import { RouteError } from "@/lib/ui/route-error";

export default function AgencyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} homeHref="/agency" homeLabel="Back to Agency Command Center" />;
}
