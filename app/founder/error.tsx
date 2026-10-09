"use client";

import { RouteError } from "@/lib/ui/route-error";

export default function FounderError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} homeHref="/founder" homeLabel="Back to Founder home" />;
}
